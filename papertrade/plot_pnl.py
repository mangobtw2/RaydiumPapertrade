import json
import matplotlib.pyplot as plt
from datetime import datetime
import matplotlib.dates as mdates

def plot_pnl():
    # Load the PnL history
    with open('pnl_history.json', 'r') as f:
        history = json.load(f)
    
    plt.figure(figsize=(12, 6))
    
    # Plot each prefix's PnL history
    for prefix_id, data_points in history.items():
        timestamps = [datetime.fromtimestamp(point['timestamp']/1000) for point in data_points]
        pnls = [point['pnl'] for point in data_points]
        plt.plot(timestamps, pnls, label=prefix_id, marker='o')
    
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%H:%M:%S'))
    plt.gcf().autofmt_xdate()  # Rotation and alignment of tick labels
    
    plt.title('PnL Over Time by Prefix')
    plt.xlabel('Time')
    plt.ylabel('PnL (SOL)')
    plt.grid(True)
    plt.legend()
    
    plt.tight_layout()
    plt.savefig('pnl_plot.png')
    plt.close()

def plot_pnl_normalized():
    # Load the PnL history
    with open('pnl_history.json', 'r') as f:
        history = json.load(f)
    
    plt.figure(figsize=(12, 6))
    
    # Plot each prefix's normalized PnL history
    for prefix_id, data_points in history.items():
        timestamps = [datetime.fromtimestamp(point['timestamp']/1000) for point in data_points]
        normalized_pnls = [point['pnl']/point['amountOfTrades'] if point['amountOfTrades'] > 0 else 0 
                          for point in data_points]
        trades = [point['amountOfTrades'] for point in data_points]
        plt.plot(timestamps, normalized_pnls, 
                label=f"{prefix_id} ({trades[-1]} trades)", marker='o')
    
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%H:%M:%S'))
    plt.gcf().autofmt_xdate()  # Rotation and alignment of tick labels
    
    plt.title('PnL per Trade Over Time by Prefix')
    plt.xlabel('Time')
    plt.ylabel('PnL per Trade (SOL)')
    plt.grid(True)
    plt.legend()
    
    plt.tight_layout()
    plt.savefig('pnl_plot_normalized.png')
    plt.close()

if __name__ == "__main__":
    plot_pnl()
    plot_pnl_normalized() 