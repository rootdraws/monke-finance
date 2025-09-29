import { Pool } from 'pg';
import { logger } from '../utils/logger';
import Big from 'big.js';

export interface CostBasisEntry {
  id: string;
  holderId: string;
  transactionId: string;
  remainingAmount: string;
  originalAmount: string;
  pricePerToken: number;
  purchaseTimestamp: Date;
}

export interface RealizedGain {
  amount: string;
  costBasis: number;
  salePrice: number;
  realizedPnl: number;
  purchaseTimestamp: Date;
  saleTimestamp: Date;
}

/**
 * FIFO Cost Basis Calculator
 * 
 * Implements First-In-First-Out cost basis tracking for accurate profit/loss calculations.
 * This is essential for holder psychology analysis and tax reporting.
 */
export class FIFOCostBasisCalculator {
  private db: Pool;

  constructor(database: Pool) {
    this.db = database;
  }

  /**
   * Add a purchase to the cost basis tracking
   */
  public async addPurchase(
    holderId: string,
    transactionId: string,
    amount: string,
    pricePerToken: number,
    purchaseTimestamp: Date
  ): Promise<void> {
    const client = await this.db.connect();

    try {
      await client.query(`
        INSERT INTO cost_basis (
          holder_id, transaction_id, remaining_amount, original_amount,
          price_per_token, purchase_timestamp, created_at
        ) VALUES ($1, $2, $3, $3, $4, $5, NOW())
      `, [
        holderId,
        transactionId,
        amount,
        pricePerToken,
        purchaseTimestamp
      ]);

      logger.debug(`Added purchase to cost basis: ${amount} at ${pricePerToken}`);
    } catch (error) {
      logger.error('Error adding purchase to cost basis:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Process a sale using FIFO method
   * Returns the total realized P&L from the sale
   */
  public async processSale(
    holderId: string,
    saleAmount: string,
    salePrice: number,
    saleTimestamp?: Date
  ): Promise<number> {
    const client = await this.db.connect();
    let totalRealizedPnl = 0;
    let remainingSaleAmount = new Big(saleAmount);

    try {
      await client.query('BEGIN');

      // Get cost basis entries in FIFO order (oldest first)
      const costBasisResult = await client.query(`
        SELECT id, remaining_amount, price_per_token, purchase_timestamp
        FROM cost_basis
        WHERE holder_id = $1 AND remaining_amount > 0
        ORDER BY purchase_timestamp ASC, created_at ASC
      `, [holderId]);

      const costBasisEntries = costBasisResult.rows;

      if (costBasisEntries.length === 0) {
        logger.warn(`No cost basis entries found for holder ${holderId}`);
        await client.query('ROLLBACK');
        return 0;
      }

      // Process each cost basis entry in FIFO order
      for (const entry of costBasisEntries) {
        if (remainingSaleAmount.lte(0)) {
          break; // We've allocated all the sale amount
        }

        const availableAmount = new Big(entry.remaining_amount);
        const useAmount = Big.min(remainingSaleAmount, availableAmount);
        const costBasis = entry.price_per_token;

        // Calculate realized P&L for this portion
        const realizedPnl = useAmount.mul(salePrice - costBasis).toNumber();
        totalRealizedPnl += realizedPnl;

        // Update remaining amount in cost basis entry
        const newRemainingAmount = availableAmount.minus(useAmount);
        await client.query(`
          UPDATE cost_basis SET
            remaining_amount = $1,
            updated_at = NOW()
          WHERE id = $2
        `, [newRemainingAmount.toString(), entry.id]);

        // Subtract used amount from remaining sale amount
        remainingSaleAmount = remainingSaleAmount.minus(useAmount);

        logger.debug(
          `FIFO sale: used ${useAmount.toString()} at cost ${costBasis}, ` +
          `sale price ${salePrice}, realized P&L: ${realizedPnl}`
        );
      }

      if (remainingSaleAmount.gt(0)) {
        logger.warn(
          `Warning: Sale amount ${saleAmount} exceeds available cost basis. ` +
          `Remaining unsold: ${remainingSaleAmount.toString()}`
        );
      }

      await client.query('COMMIT');
      
      logger.debug(`Total realized P&L from sale: ${totalRealizedPnl}`);
      return totalRealizedPnl;

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error processing FIFO sale:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get total cost basis for a holder (sum of all remaining amounts * their prices)
   */
  public async getTotalCostBasis(holderId: string): Promise<number> {
    const client = await this.db.connect();

    try {
      const result = await client.query(`
        SELECT SUM(remaining_amount::DECIMAL * price_per_token) as total_cost_basis
        FROM cost_basis
        WHERE holder_id = $1 AND remaining_amount > 0
      `, [holderId]);

      return parseFloat(result.rows[0].total_cost_basis || '0');
    } catch (error) {
      logger.error('Error calculating total cost basis:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get weighted average cost basis for a holder
   */
  public async getWeightedAverageCostBasis(holderId: string): Promise<number> {
    const client = await this.db.connect();

    try {
      const result = await client.query(`
        SELECT 
          SUM(remaining_amount::DECIMAL * price_per_token) as total_cost,
          SUM(remaining_amount::DECIMAL) as total_amount
        FROM cost_basis
        WHERE holder_id = $1 AND remaining_amount > 0
      `, [holderId]);

      const row = result.rows[0];
      const totalCost = parseFloat(row.total_cost || '0');
      const totalAmount = parseFloat(row.total_amount || '0');

      if (totalAmount === 0) {
        return 0;
      }

      return totalCost / totalAmount;
    } catch (error) {
      logger.error('Error calculating weighted average cost basis:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get unrealized P&L for a holder at current price
   */
  public async getUnrealizedPnL(
    holderId: string, 
    currentPrice: number
  ): Promise<{
    unrealizedPnl: number;
    totalAmount: string;
    averageCostBasis: number;
  }> {
    const client = await this.db.connect();

    try {
      const result = await client.query(`
        SELECT 
          SUM(remaining_amount::DECIMAL) as total_amount,
          SUM(remaining_amount::DECIMAL * price_per_token) as total_cost_basis
        FROM cost_basis
        WHERE holder_id = $1 AND remaining_amount > 0
      `, [holderId]);

      const row = result.rows[0];
      const totalAmount = new Big(row.total_amount || '0');
      const totalCostBasis = parseFloat(row.total_cost_basis || '0');

      if (totalAmount.eq(0)) {
        return {
          unrealizedPnl: 0,
          totalAmount: '0',
          averageCostBasis: 0
        };
      }

      const averageCostBasis = totalCostBasis / totalAmount.toNumber();
      const currentValue = totalAmount.mul(currentPrice).toNumber();
      const unrealizedPnl = currentValue - totalCostBasis;

      return {
        unrealizedPnl,
        totalAmount: totalAmount.toString(),
        averageCostBasis
      };
    } catch (error) {
      logger.error('Error calculating unrealized P&L:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get cost basis breakdown for a holder
   */
  public async getCostBasisBreakdown(holderId: string): Promise<CostBasisEntry[]> {
    const client = await this.db.connect();

    try {
      const result = await client.query(`
        SELECT 
          id, holder_id, transaction_id, remaining_amount,
          original_amount, price_per_token, purchase_timestamp
        FROM cost_basis
        WHERE holder_id = $1 AND remaining_amount > 0
        ORDER BY purchase_timestamp ASC, created_at ASC
      `, [holderId]);

      return result.rows.map(row => ({
        id: row.id,
        holderId: row.holder_id,
        transactionId: row.transaction_id,
        remainingAmount: row.remaining_amount,
        originalAmount: row.original_amount,
        pricePerToken: parseFloat(row.price_per_token),
        purchaseTimestamp: row.purchase_timestamp
      }));
    } catch (error) {
      logger.error('Error getting cost basis breakdown:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate profit/loss zones for holder psychology analysis
   */
  public async calculateProfitLossZones(
    tokenId: string,
    currentPrice: number
  ): Promise<{
    profitHolders: number;
    lossHolders: number;
    breakEvenHolders: number;
    totalHolders: number;
    profitAmountUSD: number;
    lossAmountUSD: number;
    breakEvenAmountUSD: number;
  }> {
    const client = await this.db.connect();

    try {
      const result = await client.query(`
        SELECT 
          h.id as holder_id,
          h.wallet_address,
          h.current_balance,
          COALESCE(
            SUM(cb.remaining_amount::DECIMAL * cb.price_per_token) / 
            NULLIF(SUM(cb.remaining_amount::DECIMAL), 0),
            0
          ) as average_cost_basis,
          SUM(cb.remaining_amount::DECIMAL) as total_cost_basis_amount
        FROM holders h
        LEFT JOIN cost_basis cb ON h.id = cb.holder_id AND cb.remaining_amount > 0
        WHERE h.token_id = $1 AND h.is_active = true AND h.current_balance > 0
        GROUP BY h.id, h.wallet_address, h.current_balance
      `, [tokenId]);

      let profitHolders = 0;
      let lossHolders = 0;
      let breakEvenHolders = 0;
      let profitAmountUSD = 0;
      let lossAmountUSD = 0;
      let breakEvenAmountUSD = 0;

      const breakEvenTolerance = 0.01; // 1% tolerance for break-even

      for (const row of result.rows) {
        const averageCostBasis = parseFloat(row.average_cost_basis);
        const currentBalance = new Big(row.current_balance || '0');
        const currentValueUSD = currentBalance.mul(currentPrice).toNumber();

        if (averageCostBasis === 0) {
          // No cost basis data (possible transfer or airdrop)
          breakEvenHolders++;
          breakEvenAmountUSD += currentValueUSD;
          continue;
        }

        const percentageChange = (currentPrice - averageCostBasis) / averageCostBasis;

        if (percentageChange > breakEvenTolerance) {
          profitHolders++;
          profitAmountUSD += currentValueUSD;
        } else if (percentageChange < -breakEvenTolerance) {
          lossHolders++;
          lossAmountUSD += currentValueUSD;
        } else {
          breakEvenHolders++;
          breakEvenAmountUSD += currentValueUSD;
        }
      }

      return {
        profitHolders,
        lossHolders,
        breakEvenHolders,
        totalHolders: result.rows.length,
        profitAmountUSD,
        lossAmountUSD,
        breakEvenAmountUSD
      };
    } catch (error) {
      logger.error('Error calculating profit/loss zones:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get price levels with significant holder concentrations
   */
  public async getHolderPriceLevels(
    tokenId: string,
    priceRangePercent = 5
  ): Promise<Array<{
    priceLevel: number;
    holderCount: number;
    totalAmount: string;
    percentageOfSupply: number;
  }>> {
    const client = await this.db.connect();

    try {
      // Get current token supply for percentage calculations
      const supplyResult = await client.query(`
        SELECT SUM(current_balance::DECIMAL) as circulating_supply
        FROM holders
        WHERE token_id = $1 AND is_active = true
      `, [tokenId]);

      const circulatingSupply = parseFloat(supplyResult.rows[0].circulating_supply || '0');

      // Get holder cost basis distribution
      const result = await client.query(`
        SELECT 
          cb.price_per_token,
          SUM(cb.remaining_amount::DECIMAL) as total_amount,
          COUNT(DISTINCT cb.holder_id) as holder_count
        FROM cost_basis cb
        JOIN holders h ON cb.holder_id = h.id
        WHERE h.token_id = $1 AND cb.remaining_amount > 0
        GROUP BY cb.price_per_token
        ORDER BY cb.price_per_token ASC
      `, [tokenId]);

      // Group nearby price levels together
      const priceLevels: Array<{
        priceLevel: number;
        holderCount: number;
        totalAmount: string;
        percentageOfSupply: number;
      }> = [];
      const groupedData = new Map<number, {
        priceLevel: number;
        totalAmount: number;
        holderCount: number;
      }>();

      for (const row of result.rows) {
        const price = parseFloat(row.price_per_token);
        const amount = parseFloat(row.total_amount);
        const count = parseInt(row.holder_count);

        // Find or create price group
        let groupKey = price;
        for (const [existingPrice] of groupedData) {
          const percentDiff = Math.abs(price - existingPrice) / existingPrice * 100;
          if (percentDiff <= priceRangePercent) {
            groupKey = existingPrice;
            break;
          }
        }

        if (groupedData.has(groupKey)) {
          const existing = groupedData.get(groupKey)!;
          existing.totalAmount += amount;
          existing.holderCount += count;
        } else {
          groupedData.set(groupKey, {
            priceLevel: price,
            totalAmount: amount,
            holderCount: count
          });
        }
      }

      // Convert to array and add percentage calculations
      for (const [priceLevel, data] of groupedData) {
        priceLevels.push({
          priceLevel,
          holderCount: data.holderCount,
          totalAmount: data.totalAmount.toString(),
          percentageOfSupply: circulatingSupply > 0 ? (data.totalAmount / circulatingSupply) * 100 : 0
        });
      }

      // Sort by amount descending (most significant levels first)
      return priceLevels.sort((a, b) => parseFloat(b.totalAmount) - parseFloat(a.totalAmount));

    } catch (error) {
      logger.error('Error getting holder price levels:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Clean up zero-amount cost basis entries
   */
  public async cleanupCostBasis(holderId?: string): Promise<void> {
    const client = await this.db.connect();

    try {
      let query = 'DELETE FROM cost_basis WHERE remaining_amount = 0';
      let params: any[] = [];

      if (holderId) {
        query += ' AND holder_id = $1';
        params.push(holderId);
      }

      const result = await client.query(query, params);
      
      logger.info(`Cleaned up ${result.rowCount} zero-amount cost basis entries`);
    } catch (error) {
      logger.error('Error cleaning up cost basis entries:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get analytics summary for dashboard
   */
  public async getAnalyticsSummary(tokenId: string, currentPrice: number): Promise<{
    totalHolders: number;
    profitLossBreakdown: any;
    topPriceLevels: any[];
    averageHolderCostBasis: number;
    medianHolderCostBasis: number;
  }> {
    try {
      const profitLossBreakdown = await this.calculateProfitLossZones(tokenId, currentPrice);
      const topPriceLevels = await this.getHolderPriceLevels(tokenId);
      
      // Get average and median cost basis
      const client = await this.db.connect();
      
      try {
        const avgResult = await client.query(`
          SELECT AVG(average_buy_price) as avg_cost_basis
          FROM holders
          WHERE token_id = $1 AND is_active = true AND current_balance > 0
        `, [tokenId]);

        const medianResult = await client.query(`
          SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY average_buy_price) as median_cost_basis
          FROM holders
          WHERE token_id = $1 AND is_active = true AND current_balance > 0 AND average_buy_price > 0
        `, [tokenId]);

        return {
          totalHolders: profitLossBreakdown.totalHolders,
          profitLossBreakdown,
          topPriceLevels: topPriceLevels.slice(0, 10), // Top 10 price levels
          averageHolderCostBasis: parseFloat(avgResult.rows[0].avg_cost_basis || '0'),
          medianHolderCostBasis: parseFloat(medianResult.rows[0].median_cost_basis || '0')
        };
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting analytics summary:', error);
      throw error;
    }
  }
}

// Export singleton
let costBasisCalculator: FIFOCostBasisCalculator;

export const getCostBasisCalculator = (database: Pool): FIFOCostBasisCalculator => {
  if (!costBasisCalculator) {
    costBasisCalculator = new FIFOCostBasisCalculator(database);
  }
  return costBasisCalculator;
};
