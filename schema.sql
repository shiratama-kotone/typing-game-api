-- ユーザーテーブル
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- スコアテーブル（曲別ベストスコアのみ保持）
CREATE TABLE IF NOT EXISTS scores (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL,
    song_title TEXT NOT NULL,
    score INTEGER NOT NULL,
    miss_count INTEGER NOT NULL DEFAULT 0,
    max_combo INTEGER NOT NULL DEFAULT 0,
    played_at TIMESTAMP DEFAULT NOW(),
    -- 同一ユーザー×同一曲は1レコードのみ
    UNIQUE(user_id, song_id)
);

-- ランキング用インデックス
CREATE INDEX IF NOT EXISTS idx_scores_song ON scores(song_id, score DESC);
