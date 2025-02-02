import pg from 'pg';
import {createClient} from 'redis';

const redisClient = createClient({
    url: 'redis://localhost:6379',
  });
  

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

interface TableSize {
    tableName: string;
    totalSize: string;
    tableSize: string;
    indexSize: string;
    rowCount: number;
}

export async function init() {
    try {
        await redisClient.connect();
        await pool.query(`
            CREATE TABLE IF NOT EXISTS compressed_trades (
                id SERIAL PRIMARY KEY,
                wallet VARCHAR(44) NOT NULL,
                pnl NUMERIC(20, 4) NOT NULL,
                timestamp BIGINT NOT NULL,
                mint VARCHAR(10) NOT NULL
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

export async function transferAllWalletsToSql(){
    const wallets = await redisClient.keys('rt:*');
    // Process each wallet
    for (let i = 0; i < wallets.length; i++) {
        if (i % 1000 === 0) {
            console.log(`Processing wallet ${i} of ${wallets.length}`);
        }

        const rawTrades = await redisClient.lRange(wallets[i], 0, -1);
        const trades: CompressedTrade[] = rawTrades.map(row => JSON.parse(row));
        const walletName = wallets[i].split(':')[1];
        await transferTradesToSql(walletName, trades);
    }
}

export async function transferTradesToSql(wallet: string, trades: CompressedTrade[]) {
    try {
        // Simple insert without conflict handling since we want to keep all trades
        const query = `
            INSERT INTO compressed_trades (wallet, pnl, timestamp, mint)
            VALUES ($1, $2, $3, $4)
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
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error transferring wallet data:', error);
        throw error;
    }
}

// Utility function to retrieve wallet data
export async function getWalletTrades(wallet: string): Promise<CompressedTrade[]> {
    try {
        const result = await pool.query(
            'SELECT * FROM compressed_trades WHERE wallet = $1',
            [wallet]
        );
        
        const trades = result.rows.map(row => ({
            pl: Number(row.pnl),
            t: Number(row.timestamp),
            m: row.mint
        }));
        return trades;
    } catch (error) {
        console.error('Error retrieving wallet data:', error);
        return [];
    }
}

export async function getAllWallets(): Promise<string[]> {
    try {
        const result = await pool.query(
            'SELECT DISTINCT wallet FROM compressed_trades'
        );
        
        return result.rows.map(row => row.wallet);
    } catch (error) {
        console.error('Error retrieving wallets:', error);
        throw error;
    }
}

export async function getTableSize(): Promise<TableSize> {
    try {
        const result = await pool.query(`
            SELECT
                pg_size_pretty(pg_total_relation_size('compressed_trades')) as total_size,
                pg_size_pretty(pg_table_size('compressed_trades')) as table_size,
                pg_size_pretty(pg_indexes_size('compressed_trades')) as index_size,
                (SELECT reltuples::bigint FROM pg_class WHERE relname = 'compressed_trades') as row_count;
        `);
        
        const row = result.rows[0];
        const size: TableSize = {
            tableName: 'compressed_trades',
            totalSize: row.total_size,    // Total size including indexes
            tableSize: row.table_size,    // Size of the table only
            indexSize: row.index_size,    // Size of all indexes
            rowCount: parseInt(row.row_count)
        };
        console.log(`Table size information:
            - Total size: ${size.totalSize}
            - Table size: ${size.tableSize}
            - Index size: ${size.indexSize}
            - Row count: ${size.rowCount}`);
        return size;
    } catch (error) {
        console.error('Error getting table size:', error);
        throw error;
    }
}