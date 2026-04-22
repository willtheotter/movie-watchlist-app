import express from 'express';
import mysql from 'mysql2/promise';
import fetch from 'node-fetch';
import session from 'express-session';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'movie-tracker-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

app.use((req, res, next) => {
    res.locals.user = req.session.username;
    next();
});

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 10,
    waitForConnections: true
});

const isAuthenticated = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const genreMap = {
    28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
    99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
    27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
    10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

app.get('/', async (req, res) => {
    const userId = req.session.userId;
    const username = req.session.username;

    try {
        let watchlist = [];

        if (userId) {
            const [rows] = await pool.execute(`
                SELECT Watchlist.*, Movies.title, Movies.poster_url 
                FROM Watchlist 
                JOIN Movies ON Watchlist.movie_id = Movies.id 
                WHERE Watchlist.user_id = ?
                LIMIT 5
            `, [userId]);
            watchlist = rows;
        }

        res.render('index', { 
            watchlist: watchlist, 
            user: username || null,
            currentPage: 'home'
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

app.get('/search', (req, res) => {
    res.render('search', { currentPage: 'search' });
});

app.get('/search-results', async (req, res) => {
    const query = req.query.query;
    if (!query) return res.redirect('/search');

    try {
        const url = `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        const data = await response.json();

        console.log("TMDB response:", data);

        if (!data.results || !Array.isArray(data.results)) {
            return res.status(500).send("TMDB API returned an invalid response");
        }

        const processedMovies = data.results.map(movie => {
            const firstGenreId = movie.genre_ids && movie.genre_ids.length > 0 ? movie.genre_ids[0] : null;
            return {
                ...movie,
                genre_name: genreMap[firstGenreId] || 'Unknown',
                rating_score: movie.vote_average || 0
            };
        });

        res.render('searchResults', { movies: processedMovies, currentPage: 'search'});
    } catch (err) {
        console.error(err);
        res.status(500).send("API Error");
    }
});

app.post('/watchlist/add', isAuthenticated, async (req, res) => {
    const { tmdb_id, title, poster_path, genre_id, rating, watched_status } = req.body;
    const userId = req.session.userId;
    
    const genreName = genreMap[Number(genre_id)] || 'Unknown';
    const initialRating = rating ? parseInt(rating) : 0;
    const isWatched = watched_status === 'on' || watched_status === 'true' ? 1 : 0;
    
    try {
        let [movies] = await pool.execute('SELECT id FROM Movies WHERE tmdb_id = ?', [tmdb_id]);
        let movieId;
        
        if (movies.length === 0) {
            const posterUrl = poster_path ? `https://image.tmdb.org/t/p/w500${poster_path}` : null;
            const [result] = await pool.execute(
                'INSERT INTO Movies (title, genre, poster_url, tmdb_id) VALUES (?, ?, ?, ?)',
                [title, genreName, posterUrl, tmdb_id]
            );
            movieId = result.insertId;
        } else {
            movieId = movies[0].id;
        }
        
        const [existing] = await pool.execute(
            'SELECT id FROM Watchlist WHERE user_id = ? AND movie_id = ?',
            [userId, movieId]
        );
        
        if (existing.length > 0) {
            return res.redirect('/watchlist?error=Movie already in your watchlist');
        }
        
        await pool.execute(
            'INSERT INTO Watchlist (user_id, movie_id, rating, watched_status) VALUES (?, ?, ?, ?)',
            [userId, movieId, initialRating, isWatched]
        );
        
        res.redirect('/watchlist?success=Movie added successfully');
        
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding movie to database");
    }
});

app.get('/watchlist', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const success = req.query.success;
    const error = req.query.error;
    
    try {
        const [rows] = await pool.execute(`
            SELECT Watchlist.*, Movies.title, Movies.poster_url, Movies.genre
            FROM Watchlist 
            JOIN Movies ON Watchlist.movie_id = Movies.id 
            WHERE Watchlist.user_id = ?
            ORDER BY Watchlist.watched_status ASC, Watchlist.id DESC
        `, [userId]);
        
        res.render('watchlist', { movies: rows, success, error, user: req.session.username, currentPage: 'watchlist'});
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching watchlist");
    }
});

app.get('/edit/:id', isAuthenticated, async (req, res) => {
    const idParam = req.params.id;
    const userId = req.session.userId;
    
    try {
        const [rows] = await pool.execute(`
            SELECT Watchlist.*, Movies.title, Movies.poster_url, Movies.genre, Movies.tmdb_id
            FROM Watchlist 
            JOIN Movies ON Watchlist.movie_id = Movies.id 
            WHERE (Watchlist.id = ? OR Movies.tmdb_id = ?) AND Watchlist.user_id = ?
        `, [idParam, idParam, userId]);
        
        if (rows.length > 0) {
            res.render('editWatchlist', { movie: rows[0], user: req.session.username, currentPage: 'watchlist'});
        } else {
            console.log(`Edit failed for ID: ${idParam} and User: ${userId}`);
            res.status(404).send("Movie not found in your watchlist.");
        }
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

app.post('/watchlist/update', isAuthenticated, async (req, res) => {
    const { id, rating, watched_status, personal_review } = req.body;
    const userId = req.session.userId;
    
    const isWatched = watched_status === 'on' ? 1 : 0;
    const ratingValue = rating ? parseInt(rating) : 0;
    
    try {
        const [check] = await pool.execute(
            'SELECT id FROM Watchlist WHERE id = ? AND user_id = ?',
            [id, userId]
        );
        
        if (check.length === 0) {
            return res.status(403).send("Unauthorized");
        }
        
        await pool.execute(
            'UPDATE Watchlist SET rating = ?, watched_status = ?, personal_review = ? WHERE id = ?',
            [ratingValue, isWatched, personal_review || null, id]
        );
        
        res.redirect('/watchlist?success=Movie updated successfully');
    } catch (err) {
        console.error(err);
        res.status(500).send("Failed to update movie.");
    }
});

app.post('/watchlist/delete', isAuthenticated, async (req, res) => {
    const { id } = req.body;
    const userId = req.session.userId;
    
    try {
        const [check] = await pool.execute(
            'SELECT id FROM Watchlist WHERE id = ? AND user_id = ?',
            [id, userId]
        );
        
        if (check.length === 0) {
            return res.status(403).send("Unauthorized");
        }
        
        await pool.execute('DELETE FROM Watchlist WHERE id = ?', [id]);
        res.redirect('/watchlist?success=Movie removed from watchlist');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error removing movie from watchlist");
    }
});

app.get('/api/user-stats', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    
    try {
        const [stats] = await pool.execute(`
            SELECT 
                COUNT(*) as total_movies,
                SUM(watched_status) as watched_count,
                AVG(rating) as avg_rating
            FROM Watchlist 
            WHERE user_id = ?
        `, [userId]);
        
        res.json({
            total: stats[0].total_movies || 0,
            watched: stats[0].watched_count || 0,
            avgRating: Math.round((stats[0].avg_rating || 0) * 10) / 10
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.render('login', { error: 'Username and password required' });
    }
    
    try {
        const [users] = await pool.execute(
            'SELECT id, username, email, password FROM Users WHERE username = ? OR email = ?',
            [username, username]
        );
        
        if (users.length === 0) {
            return res.render('login', { error: 'Invalid username or password' });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.render('login', { error: 'Invalid username or password' });
        }
        
        req.session.userId = user.id;
        req.session.username = user.username;
        
        res.redirect('/sync-guest-data');
        
    } catch (err) {
        console.error(err);
        res.status(500).render('login', { error: 'Login failed. Please try again.' });
    }
});

app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
    const { username, email, password, confirm_password } = req.body;
    
    if (!username || !email || !password) {
        return res.render('register', { error: 'All fields are required' });
    }
    
    if (password !== confirm_password) {
        return res.render('register', { error: 'Passwords do not match' });
    }
    
    if (password.length < 6) {
        return res.render('register', { error: 'Password must be at least 6 characters' });
    }
    
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM Users WHERE username = ? OR email = ?',
            [username, email]
        );
        
        if (existing.length > 0) {
            return res.render('register', { error: 'Username or email already taken' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const [result] = await pool.execute(
            'INSERT INTO Users (username, email, password) VALUES (?, ?, ?)',
            [username, email, hashedPassword]
        );
        
        req.session.userId = result.insertId;
        req.session.username = username;
        
        res.redirect('/sync-guest-data');
        
    } catch (err) {
        console.error(err);
        res.status(500).render('register', { error: 'Registration failed. Please try again.' });
    }
});

app.get('/sync-guest-data', isAuthenticated, (req, res) => {
    res.render('syncData', { user: req.session.username, currentPage: 'sync' });
});

app.post('/api/sync-watchlist', isAuthenticated, async (req, res) => {
    const { guestWatchlist } = req.body;
    const userId = req.session.userId;
    
    if (!guestWatchlist || !Array.isArray(guestWatchlist) || guestWatchlist.length === 0) {
        return res.json({ success: true, message: 'No guest data to sync' });
    }
    
    let syncedCount = 0;
    
    try {
        for (const guestMovie of guestWatchlist) {
            let [movies] = await pool.execute(
                'SELECT id FROM Movies WHERE tmdb_id = ?',
                [guestMovie.tmdb_id]
            );
            
            let movieId;
            
            if (movies.length === 0) {
                const [result] = await pool.execute(
                    'INSERT INTO Movies (title, genre, poster_url, tmdb_id) VALUES (?, ?, ?, ?)',
                    [guestMovie.title, guestMovie.genre, guestMovie.poster_url, guestMovie.tmdb_id]
                );
                movieId = result.insertId;
            } else {
                movieId = movies[0].id;
            }
            
            const [existing] = await pool.execute(
                'SELECT id FROM Watchlist WHERE user_id = ? AND movie_id = ?',
                [userId, movieId]
            );
            
            if (existing.length === 0) {
                await pool.execute(
                    'INSERT INTO Watchlist (user_id, movie_id, rating, watched_status, personal_review) VALUES (?, ?, ?, ?, ?)',
                    [userId, movieId, guestMovie.rating || 0, guestMovie.watched_status || false, guestMovie.personal_review || null]
                );
                syncedCount++;
            }
        }
        
        res.json({ success: true, syncedCount, message: `Synced ${syncedCount} movies to your account` });
        
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Sync failed' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.log(err);
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/api/fake-reviews/:movieId', isAuthenticated, async (req, res) => {
    const movieId = req.params.movieId;

    try {
        const tmdbUrl = `${TMDB_BASE_URL}/movie/${movieId}/reviews?api_key=${TMDB_API_KEY}`;
        const tmdbRes = await fetch(tmdbUrl);
        const tmdbData = await tmdbRes.json();

        const realReviews = (tmdbData.results || []).slice(0, 3).map(review => ({
            reviewer: review.author,
            text: review.content.length > 300 
                  ? review.content.substring(0, 300) + "..." 
                  : review.content
        }));

        if (realReviews.length === 0) {
            realReviews.push({ 
                reviewer: "System", 
                text: "No community reviews found for this title yet." 
            });
        }

        const idNum = parseInt(movieId);
        const totalLikes = (idNum % 150) + Math.floor((idNum / 7) % 50) + 10;

        res.json({
            reviews: realReviews,
            totalLikes: totalLikes
        });

    } catch (err) {
        console.error("Review Fetch Error:", err);
        res.status(500).json({ error: 'Could not load combined review data' });
    }
});

app.get('/movie/:id', isAuthenticated, async (req, res) => {
    const movieId = req.params.id;
    const userId = req.session.userId;

    try {
        const [rows] = await pool.execute(`
            SELECT Movies.*, Watchlist.rating, Watchlist.watched_status, Watchlist.personal_review
            FROM Movies
            LEFT JOIN Watchlist ON Movies.id = Watchlist.movie_id AND Watchlist.user_id = ?
            WHERE Movies.id = ?
        `, [userId, movieId]);

        if (rows.length === 0) {
            return res.status(404).send("Movie not found");
        }

        res.render('movieDetails', { movie: rows[0], currentPage: 'watchlist' });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});



app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});