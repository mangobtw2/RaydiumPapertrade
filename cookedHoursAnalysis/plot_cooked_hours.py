import json
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

# Read the JSON file
with open('results/interval_pnls.json', 'r') as f:
    data = json.load(f)

# Convert to DataFrame
df = pd.DataFrame(data)

# Convert timestamps to datetime
df['datetime'] = pd.to_datetime(df['startTimestamp'], unit='ms')

# Calculate moving averages (3 intervals = 15 min, 6 intervals = 30 min)
df['MA_15min'] = df['totalPnL'].rolling(window=3, center=True).mean()
df['MA_30min'] = df['totalPnL'].rolling(window=6, center=True).mean()

# Create the plot
plt.figure(figsize=(15, 8))

# Plot raw PnL data
plt.plot(df['datetime'], df['totalPnL'], 'b-', alpha=0.3, label='5-min intervals')

# Plot moving averages
plt.plot(df['datetime'], df['MA_15min'], 'r-', linewidth=2, label='15-min MA')
plt.plot(df['datetime'], df['MA_30min'], 'g-', linewidth=2, label='30-min MA')

# Add horizontal line at y=0
plt.axhline(y=0, color='k', linestyle='--', alpha=0.3)

# Customize the plot
plt.title('PnL Over Time with Moving Averages')
plt.xlabel('Time')
plt.ylabel('PnL (SOL)')
plt.grid(True, alpha=0.3)
plt.legend()

# Rotate x-axis labels for better readability
plt.xticks(rotation=45)

# Adjust layout to prevent label cutoff
plt.tight_layout()

# Add trade count as text
total_trades = df['tradeCount'].sum()
avg_pnl = df['totalPnL'].mean()
plt.text(0.02, 0.98, f'Total Trades: {total_trades}\nAverage PnL: {avg_pnl:.4f}', 
         transform=plt.gca().transAxes, 
         bbox=dict(facecolor='white', alpha=0.8))

# Save the plot
plt.savefig('results/pnl_analysis.png', dpi=300, bbox_inches='tight')
plt.close()

# Print some basic statistics
print(f"Analysis Summary:")
print(f"Total number of intervals: {len(df)}")
print(f"Total trades: {total_trades}")
print(f"Average PnL per interval: {avg_pnl:.4f}")
print(f"Total PnL: {df['totalPnL'].sum():.4f}")
print(f"Time range: {df['datetime'].min()} to {df['datetime'].max()}")