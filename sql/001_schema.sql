CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email VARCHAR(255), accountnumber VARCHAR(20));
CREATE TABLE IF NOT EXISTS instruments (id SERIAL PRIMARY KEY, ticker VARCHAR(10), name VARCHAR(255), type VARCHAR(10));
CREATE TABLE IF NOT EXISTS orders (
 id SERIAL PRIMARY KEY, instrumentid INT REFERENCES instruments(id), userid INT REFERENCES users(id), size INT,
 price NUMERIC(10,2), type VARCHAR(10), side VARCHAR(10), status VARCHAR(20), datetime TIMESTAMP
);
CREATE TABLE IF NOT EXISTS marketdata (
 id SERIAL PRIMARY KEY, instrumentid INT REFERENCES instruments(id), high NUMERIC(10,2), low NUMERIC(10,2),
 open NUMERIC(10,2), close NUMERIC(10,2), previousclose NUMERIC(10,2), date DATE
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
CREATE TABLE IF NOT EXISTS order_requests (
 userid INT NOT NULL REFERENCES users(id), key VARCHAR(128) NOT NULL,
 fingerprint CHAR(64) NOT NULL, response JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(userid,key)
);
CREATE INDEX IF NOT EXISTS orders_user_status_idx ON orders(userid,status,instrumentid);
CREATE INDEX IF NOT EXISTS marketdata_latest_idx ON marketdata(instrumentid,date DESC,id DESC);
