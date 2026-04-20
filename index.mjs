console.log("FILE IS RUNNING"); 
import dotenv from 'dotenv';
dotenv.config();

//import packages
import express from 'express';
import mysql from 'mysql2/promise';

const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));

//for Express to get values using POST method
app.use(express.urlencoded({extended:true}));

//setting up database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    connectionLimit: 10,
    waitForConnections: true
});

//New User Get and Post
app.get('/newUser', (req, res) => {
    res.render('newUser');
});

app.post('/newUser', async (req, res) => {
    let { username, email, password} = req.body;

    let sql = `
        INSERT INTO users (username, email, password)
        VALUES (?, ?, ?)
    `;

    await pool.query(sql, [username, email, password]);

    res.redirect('/index');
});


//dbTest
app.get("/dbTest", async (req, res) => {
    let sql = "SELECT CURDATE();";
    const [rows] = await pool.query(sql);
    res.send(rows);
});


app.listen(3000, () => {
    //Print message to see it works
    console.log("Server started on port 3000");
});