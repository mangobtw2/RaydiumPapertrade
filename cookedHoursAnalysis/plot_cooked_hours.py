import json
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

def load_and_prepare_data(filename='cookedHoursAnalysis/interval_pnls.json'):
    """Load JSON data and prepare DataFrame."""
    with open(filename, 'r') as f:
        data = json.load(f)
    
    df = pd.DataFrame(data)
    # Convert to UTC first, then shift to UTC+1
    df['datetime'] = pd.to_datetime(df['startTimestamp'], unit='ms').dt.tz_localize('UTC').dt.tz_convert('Europe/Paris')
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
    """Plot median PnLs with moving averages and quartiles."""
    # Calculate moving averages
    df['MA_15min'] = df['medianPnL'].rolling(window=3, center=True).mean()
    df['MA_30min'] = df['medianPnL'].rolling(window=6, center=True).mean()

    # Create the plot
    plt.figure(figsize=(15, 8))

    # Plot quartile range
    plt.fill_between(df['datetime'], df['percentile25'], df['percentile75'], 
                     color='blue', alpha=0.2, label='25-75 percentile range')

    # Plot raw median PnL data and moving averages
    plt.plot(df['datetime'], df['medianPnL'], 'b-', alpha=0.3, label='5-min intervals')
    plt.plot(df['datetime'], df['MA_15min'], 'r-', linewidth=2, label='15-min MA')
    plt.plot(df['datetime'], df['MA_30min'], 'g-', linewidth=2, label='30-min MA')
    plt.axhline(y=0, color='k', linestyle='--', alpha=0.3)

    # Customize the plot
    plt.title('Median PnL per Interval with Moving Averages and Quartiles')
    plt.xlabel('Time')
    plt.ylabel('PnL (SOL)')
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.xticks(rotation=45)

    # Add statistics as text
    total_trades = df['tradeCount'].sum()
    overall_median = df['medianPnL'].median()
    plt.text(0.02, 0.98, 
             f'Total Trades: {total_trades}\n'
             f'Overall Median PnL: {overall_median:.4f}\n'
             f'Avg 25th percentile: {df["percentile25"].mean():.4f}\n'
             f'Avg 75th percentile: {df["percentile75"].mean():.4f}', 
             transform=plt.gca().transAxes, 
             bbox=dict(facecolor='white', alpha=0.8))

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    print_statistics_median(df)

def plot_cumulative_pnl(df, output_path='cookedHoursAnalysis/cumulative_pnl_analysis.png'):
    """Plot cumulative PnL over time."""
    # Calculate cumulative PnL
    df['cumulativePnL'] = df['totalPnL'].cumsum()

    # Create the plot
    plt.figure(figsize=(15, 8))

    # Plot cumulative PnL
    plt.plot(df['datetime'], df['cumulativePnL'], 'b-', linewidth=2, label='Cumulative PnL')
    plt.axhline(y=0, color='k', linestyle='--', alpha=0.3)

    # Customize the plot
    plt.title('Cumulative PnL Over Time')
    plt.xlabel('Time')
    plt.ylabel('Cumulative PnL (SOL)')
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.xticks(rotation=45)

    # Add statistics as text
    total_trades = df['tradeCount'].sum()
    final_pnl = df['cumulativePnL'].iloc[-1]
    max_drawdown = (df['cumulativePnL'] - df['cumulativePnL'].expanding().max()).min()
    plt.text(0.02, 0.98, 
             f'Total Trades: {total_trades}\n'
             f'Final PnL: {final_pnl:.4f}\n'
             f'Max Drawdown: {max_drawdown:.4f}', 
             transform=plt.gca().transAxes, 
             bbox=dict(facecolor='white', alpha=0.8))

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    print("\nCumulative PnL Analysis Summary:")
    print(f"Total number of intervals: {len(df)}")
    print(f"Total trades: {total_trades}")
    print(f"Final PnL: {final_pnl:.4f}")
    print(f"Max Drawdown: {max_drawdown:.4f}")
    print(f"Time range: {df['datetime'].min()} to {df['datetime'].max()}")

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
    print(f"Average 25th percentile: {df['percentile25'].mean():.4f}")
    print(f"Average 75th percentile: {df['percentile75'].mean():.4f}")
    print(f"Time range: {df['datetime'].min()} to {df['datetime'].max()}")

def main():
    """Main function to run all analyses."""
    df = load_and_prepare_data()
    plot_total_pnls(df)
    plot_average_pnls(df)
    plot_median_pnls(df)
    plot_cumulative_pnl(df)
    # df = load_and_prepare_data('cookedHoursAnalysis/interval_pnls_wallets.json')
    # plot_total_pnls(df, 'cookedHoursAnalysis/total_pnl_analysis_wallets.png')
    # plot_average_pnls(df, 'cookedHoursAnalysis/average_pnl_analysis_wallets.png')
    # plot_median_pnls(df, 'cookedHoursAnalysis/median_pnl_analysis_wallets.png')
    # plot_cumulative_pnl(df, 'cookedHoursAnalysis/cumulative_pnl_analysis_wallets.png')
if __name__ == "__main__":
    main()