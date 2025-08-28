import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

// Подключение к MySQL
const db = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

// SMTP транспорт
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// 📌 Регистрация
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);

  await db.query("INSERT INTO users (email, password_hash) VALUES (?, ?)", [email, hash]);
  res.json({ message: "User registered" });
});

// 📌 Логин → генерим JWT + шлём код на почту
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await db.query("SELECT * FROM users WHERE email=?", [email]);

  if (rows.length === 0) return res.status(401).json({ error: "User not found" });

  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid password" });

  // Генерация 6-значного кода
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 5 * 60 * 1000);

  await db.query("INSERT INTO twofactor_codes (user_id, code, expires_at) VALUES (?, ?, ?)", [user.id, code, expires]);

  // Отправка кода на почту
  await transporter.sendMail({
    from: `"Sentinel" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Sentinel 2FA Code",
    text: `Ваш код: ${code} (действует 5 минут)`
  });

  res.json({ message: "Check your email for 2FA code" });
});

// 📌 Подтверждение кода
app.post("/verify-2fa", async (req, res) => {
  const { email, code } = req.body;
  const [rows] = await db.query(
    `SELECT users.id, c.code, c.expires_at, c.used 
     FROM users 
     JOIN twofactor_codes c ON c.user_id = users.id
     WHERE users.email=? 
     ORDER BY c.id DESC LIMIT 1`,
    [email]
  );

  if (rows.length === 0) return res.status(400).json({ error: "No code found" });

  const record = rows[0];
  if (record.used) return res.status(400).json({ error: "Code already used" });
  if (record.code !== code) return res.status(400).json({ error: "Invalid code" });
  if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: "Code expired" });

  // Помечаем код использованным
  await db.query("UPDATE twofactor_codes SET used=1 WHERE code=? AND user_id=?", [code, record.id]);

  // Генерация JWT
  const token = jwt.sign({ id: record.id, email }, process.env.JWT_SECRET, { expiresIn: "2h" });
  res.json({ message: "Login successful", token });
});

app.listen(process.env.PORT, () => console.log(`✅ Sentinel running on port ${process.env.PORT}`));