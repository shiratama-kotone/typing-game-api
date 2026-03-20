require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const pool    = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET   = process.env.JWT_SECRET;
const SALT_ROUNDS  = 10;
const TOKEN_EXPIRY = '30d';

// ===== 認証ミドルウェア =====
function auth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: '認証が必要です' });
    }
    try {
        req.user = jwt.verify(header.slice(7), JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'トークンが無効です' });
    }
}

// ===== ヘルスチェック（UptimeRobot用） =====
app.get('/', (req, res) => res.json({ status: 'ok' }));

// ===== ユーザー登録 =====
// POST /auth/register  { username, password }
app.post('/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
    }
    if (username.length > 64) {
        return res.status(400).json({ error: 'ユーザー名は64文字以内にしてください' });
    }
    if (password.length > 128) {
        return res.status(400).json({ error: 'パスワードは128文字以内にしてください' });
    }
    try {
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await pool.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
            [username, hash]
        );
        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
        res.json({ token, username: user.username });
    } catch (e) {
        if (e.code === '23505') {
            return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
        }
        console.error(e);
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

// ===== ログイン =====
// POST /auth/login  { username, password }
app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
    }
    try {
        const result = await pool.query(
            'SELECT id, username, password_hash FROM users WHERE username = $1',
            [username]
        );
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
        }
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
        res.json({ token, username: user.username });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

// ===== スコア送信（ベストスコアのみ保持） =====
// POST /scores  { song_id, song_title, score, miss_count, max_combo }
app.post('/scores', auth, async (req, res) => {
    const { song_id, song_title, score, miss_count = 0, max_combo = 0 } = req.body;
    if (!song_id || !song_title || score == null) {
        return res.status(400).json({ error: '必要なパラメータが不足しています' });
    }
    try {
        // ベストスコアより高い場合のみ更新
        await pool.query(`
            INSERT INTO scores (user_id, song_id, song_title, score, miss_count, max_combo, played_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (user_id, song_id)
            DO UPDATE SET
                score      = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.score ELSE scores.score END,
                miss_count = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.miss_count ELSE scores.miss_count END,
                max_combo  = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.max_combo ELSE scores.max_combo END,
                played_at  = CASE WHEN EXCLUDED.score > scores.score THEN NOW() ELSE scores.played_at END
        `, [req.user.id, song_id, song_title, score, miss_count, max_combo]);

        // 現在のベストスコアを返す
        const result = await pool.query(
            'SELECT score, miss_count, max_combo FROM scores WHERE user_id = $1 AND song_id = $2',
            [req.user.id, song_id]
        );
        res.json({ best: result.rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

// ===== 曲別ランキング取得 =====
// GET /ranking/:song_id?limit=50
app.get('/ranking/:song_id', async (req, res) => {
    const { song_id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    try {
        const result = await pool.query(`
            SELECT u.username, s.score, s.miss_count, s.max_combo, s.played_at
            FROM scores s
            JOIN users u ON s.user_id = u.id
            WHERE s.song_id = $1
            ORDER BY s.score DESC
            LIMIT $2
        `, [song_id, limit]);
        res.json({ ranking: result.rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

// ===== 自分のベストスコア一覧 =====
// GET /scores/me
app.get('/scores/me', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT song_id, song_title, score, miss_count, max_combo, played_at
            FROM scores
            WHERE user_id = $1
            ORDER BY score DESC
        `, [req.user.id]);
        res.json({ scores: result.rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

// ===== 自分の特定曲のベストスコア =====
// GET /scores/me/:song_id
app.get('/scores/me/:song_id', auth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT score, miss_count, max_combo, played_at FROM scores WHERE user_id = $1 AND song_id = $2',
            [req.user.id, req.params.song_id]
        );
        res.json({ best: result.rows[0] || null });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`typing-game-api listening on port ${PORT}`));
