import pg from 'pg';

// Database connection pool
export const pool = new pg.Pool({
    user: "mango",
    host: "localhost",
    database: "raydiumTrades",
    password: "Valerie0.",
    port: 5432,
  });

interface CompressedWalletData {
    wallet: string;
    trades: CompressedTrade[];
    totalPnl: number;
    tradeCount: number;
}

interface CompressedTrade {
    pl: number; //Pnl
    t: number; //timestamp
    m: string; //first 10 chars of mint
}

export async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS compressed_trades (
                wallet VARCHAR(44) NOT NULL,
                pnl NUMERIC(20, 4) NOT NULL,
                timestamp BIGINT NOT NULL,
                mint VARCHAR(10) NOT NULL,
                PRIMARY KEY (wallet, timestamp, mint)
            );
            
            -- Index for fast wallet lookups
            CREATE INDEX IF NOT EXISTS idx_compressed_trades_wallet 
            ON compressed_trades(wallet);
            
            -- Index for timestamp-based queries
            CREATE INDEX IF NOT EXISTS idx_compressed_trades_timestamp 
            ON compressed_trades(timestamp);
        `);
        
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
}

export async function transferWalletToSql(wallet: string, trades: CompressedTrade[]) {
    try {
        // Using a prepared statement for bulk insert
        const query = `
            INSERT INTO compressed_trades (wallet, pnl, timestamp, mint)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (wallet, timestamp, mint) 
            DO UPDATE SET 
                pnl = EXCLUDED.pnl;
        `;
        
        // Execute all inserts in a single transaction
        await pool.query('BEGIN');
        
        for (const trade of trades) {
            await pool.query(query, [
                wallet,
                trade.pl,
                trade.t,
                trade.m
            ]);
        }
        
        await pool.query('COMMIT');
        
        console.log(`Successfully transferred trades for wallet: ${wallet}`);
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error transferring wallet data:', error);
        throw error;
    }
}

// Utility function to retrieve wallet data
export async function getWalletData(wallet: string): Promise<CompressedWalletData | null> {
    try {
        const result = await pool.query(
            'SELECT * FROM compressed_trades WHERE wallet = $1',
            [wallet]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        const row = result.rows[0];
        return {
            wallet: row.wallet,
            trades: [
                {
                    pl: Number(row.pnl),
                    t: Number(row.timestamp),
                    m: row.mint
                }
            ],
            totalPnl: Number(row.pnl),
            tradeCount: 1
        };
    } catch (error) {
        console.error('Error retrieving wallet data:', error);
        throw error;
    }
}

export async function getAllWallets(): Promise<string[]> {
    try {
        const result = await pool.query(
            'SELECT DISTINCT wallet FROM compressed_trades ORDER BY wallet'
        );
        
        return result.rows.map(row => row.wallet);
    } catch (error) {
        console.error('Error retrieving wallets:', error);
        throw error;
    }
}