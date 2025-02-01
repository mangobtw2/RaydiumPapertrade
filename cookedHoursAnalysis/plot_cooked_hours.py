import json
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

def load_and_prepare_data():
    """Load JSON data and prepare DataFrame."""
    with open('cookedHoursAnalysis/interval_pnls.json', 'r') as f:
        data = json.load(f)
    
    df = pd.DataFrame(data)
    df['datetime'] = pd.to_datetime(df['startTimestamp'], unit='ms')
    return df

def plot_total_pnls(df, output_path='cookedHoursAnalysis/total_pnl_analysis.png'):
    """Plot total PnLs with moving averages."""
    # Calculate moving averages
    df['MA_15min'] = df['totalPnL'].rolling(window=3, center=True).mean()
    df['MA_30min'] = df['totalPnL'].rolling(window=6, center=True).mean()

    # Create the plot
    plt.figure(figsize=(15, 8))

    # Plot raw PnL data
    plt.plot(df['datetime'], df['totalPnL'], 'b-', alpha=0.3, label='5-min intervals')
    plt.plot(df['datetime'], df['MA_15min'], 'r-', linewidth=2, label='15-min MA')
    plt.plot(df['datetime'], df['MA_30min'], 'g-', linewidth=2, label='30-min MA')
    plt.axhline(y=0, color='k', linestyle='--', alpha=0.3)

    # Customize the plot
    plt.title('Total PnL Over Time with Moving Averages')
    plt.xlabel('Time')
    plt.ylabel('Total PnL (SOL)')
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.xticks(rotation=45)

    # Add statistics as text
    total_trades = df['tradeCount'].sum()
    avg_pnl = df['totalPnL'].mean()
    plt.text(0.02, 0.98, 
             f'Total Trades: {total_trades}\nAverage PnL: {avg_pnl:.4f}', 
             transform=plt.gca().transAxes, 
             bbox=dict(facecolor='white', alpha=0.8))

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    print_statistics(df, "Total PnL")

def plot_average_pnls(df, output_path='cookedHoursAnalysis/average_pnl_analysis.png'):
    """Plot average PnLs (total PnL / trade count) with moving averages."""
    # Calculate average PnL per trade for each interval
    df['avgPnL'] = df['totalPnL'] / df['tradeCount'].where(df['tradeCount'] > 0, float('nan'))
    
    # Calculate moving averages
    df['MA_15min'] = df['avgPnL'].rolling(window=3, center=True).mean()
    df['MA_30min'] = df['avgPnL'].rolling(window=6, center=True).mean()

    # Create the plot
    plt.figure(figsize=(15, 8))

    # Plot raw average PnL data
    plt.plot(df['datetime'], df['avgPnL'], 'b-', alpha=0.3, label='5-min intervals')
    plt.plot(df['datetime'], df['MA_15min'], 'r-', linewidth=2, label='15-min MA')
    plt.plot(df['datetime'], df['MA_30min'], 'g-', linewidth=2, label='30-min MA')
    plt.axhline(y=0, color='k', linestyle='--', alpha=0.3)

    # Customize the plot
    plt.title('Average PnL per Trade Over Time with Moving Averages')
    plt.xlabel('Time')
    plt.ylabel('Average PnL per Trade (SOL)')
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.xticks(rotation=45)

    # Add statistics as text
    total_trades = df['tradeCount'].sum()
    overall_avg_pnl = df['totalPnL'].sum() / total_trades if total_trades > 0 else 0
    plt.text(0.02, 0.98, 
             f'Total Trades: {total_trades}\nOverall Average PnL: {overall_avg_pnl:.4f}', 
             transform=plt.gca().transAxes, 
             bbox=dict(facecolor='white', alpha=0.8))

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    print_statistics(df, "Average PnL per Trade")

def plot_median_pnls(df, output_path='cookedHoursAnalysis/median_pnl_analysis.png'):
    """Plot median PnLs with moving averages."""
    # Calculate moving averages
    df['MA_15min'] = df['medianPnL'].rolling(window=3, center=True).mean()
    df['MA_30min'] = df['medianPnL'].rolling(window=6, center=True).mean()

    # Create the plot
    plt.figure(figsize=(15, 8))

    # Plot raw median PnL data
    plt.plot(df['datetime'], df['medianPnL'], 'b-', alpha=0.3, label='5-min intervals')
    plt.plot(df['datetime'], df['MA_15min'], 'r-', linewidth=2, label='15-min MA')
    plt.plot(df['datetime'], df['MA_30min'], 'g-', linewidth=2, label='30-min MA')
    plt.axhline(y=0, color='k', linestyle='--', alpha=0.3)

    # Customize the plot
    plt.title('Median PnL per Interval with Moving Averages')
    plt.xlabel('Time')
    plt.ylabel('Median PnL (SOL)')
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.xticks(rotation=45)

    # Add statistics as text
    total_trades = df['tradeCount'].sum()
    overall_median = df['medianPnL'].median()
    plt.text(0.02, 0.98, 
             f'Total Trades: {total_trades}\nOverall Median PnL: {overall_median:.4f}', 
             transform=plt.gca().transAxes, 
             bbox=dict(facecolor='white', alpha=0.8))

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    print_statistics_median(df)

def print_statistics(df, analysis_type):
    """Print basic statistics about the data."""
    print(f"\n{analysis_type} Analysis Summary:")
    print(f"Total number of intervals: {len(df)}")
    print(f"Total trades: {df['tradeCount'].sum()}")
    
    if analysis_type == "Total PnL":
        print(f"Average PnL per interval: {df['totalPnL'].mean():.4f}")
        print(f"Total PnL: {df['totalPnL'].sum():.4f}")
    else:
        overall_avg = df['totalPnL'].sum() / df['tradeCount'].sum() if df['tradeCount'].sum() > 0 else 0
        print(f"Overall average PnL per trade: {overall_avg:.4f}")
    
    print(f"Time range: {df['datetime'].min()} to {df['datetime'].max()}")

def print_statistics_median(df):
    """Print basic statistics about the median data."""
    print("\nMedian PnL Analysis Summary:")
    print(f"Total number of intervals: {len(df)}")
    print(f"Total trades: {df['tradeCount'].sum()}")
    print(f"Overall median of interval medians: {df['medianPnL'].median():.4f}")
    print(f"Average of interval medians: {df['medianPnL'].mean():.4f}")
    print(f"Time range: {df['datetime'].min()} to {df['datetime'].max()}")

def main():
    """Main function to run all analyses."""
    df = load_and_prepare_data()
    plot_total_pnls(df)
    plot_average_pnls(df)
    plot_median_pnls(df)

if __name__ == "__main__":
    main()