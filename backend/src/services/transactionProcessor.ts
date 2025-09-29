import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { getSolanaTrackerClient, TokenTransaction, TokenLaunch } from './solanaTrackerClient';
import { FIFOCostBasisCalculator } from './costBasisCalculator';
import Big from 'big.js';

export interface ProcessedTransaction {
  id: string;
  tokenId: string;
  signature: string;
  walletAddress: string;
  transactionType: 'buy' | 'sell' | 'transfer';
  amount: string;
  pricePerToken: number;
  totalValue: number;
  blockTime: Date;
  slot: number;
}

export interface HolderPosition {
  id: string;
  tokenId: string;
  walletAddress: string;
  currentBalance: string;
  totalBought: string;
  totalSold: string;
  averageBuyPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  firstBuyTimestamp?: Date;
  lastTransactionTimestamp: Date;
  isActive: boolean;
}

export class TransactionProcessor {
  private db: Pool;
  private costBasisCalculator: FIFOCostBasisCalculator;
  private isProcessing = false;
  private processingQueue: TokenTransaction[] = [];

  constructor(database: Pool) {
    this.db = database;
    this.costBasisCalculator = new FIFOCostBasisCalculator(database);
    this.setupEventListeners();
  }

  /**
   * Set up event listeners for Solana Tracker WebSocket
   */
  private setupEventListeners(): void {
    const client = getSolanaTrackerClient();

    client.on('transaction', this.handleTransaction.bind(this));
    client.on('tokenLaunch', this.handleTokenLaunch.bind(this));
    client.on('tokenGraduation', this.handleTokenGraduation.bind(this));
    client.on('connected', this.handleConnection.bind(this));
    client.on('disconnected', this.handleDisconnection.bind(this));
    client.on('error', this.handleError.bind(this));

    logger.info('Transaction processor event listeners initialized');
  }

  /**
   * Handle incoming transactions from WebSocket
   */
  private async handleTransaction(transaction: TokenTransaction): Promise<void> {
    try {
      logger.debug(`Processing transaction: ${transaction.signature}`);
      
      // Add to processing queue
      this.processingQueue.push(transaction);
      
      // Process queue if not already processing
      if (!this.isProcessing) {
        await this.processQueue();
      }
    } catch (error) {
      logger.error('Error handling transaction:', error);
    }
  }

  /**
   * Process the transaction queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.processingQueue.length > 0) {
        const transaction = this.processingQueue.shift()!;
        await this.processTransaction(transaction);
      }
    } catch (error) {
      logger.error('Error processing transaction queue:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single transaction
   */
  private async processTransaction(transaction: TokenTransaction): Promise<void> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // Check if transaction already exists
      const existingTx = await client.query(
        'SELECT id FROM transactions WHERE signature = $1',
        [transaction.signature]
      );

      if (existingTx.rows.length > 0) {
        logger.debug(`Transaction ${transaction.signature} already processed`);
        await client.query('ROLLBACK');
        return;
      }

      // Get or create token record
      const tokenId = await this.ensureTokenExists(client, transaction.tokenAddress);

      // Insert transaction record
      const insertTxResult = await client.query(`
        INSERT INTO transactions (
          token_id, signature, wallet_address, transaction_type,
          amount, price_per_token, total_value, block_time, slot,
          block_hash, instruction_index, inner_instruction_index
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `, [
        tokenId,
        transaction.signature,
        transaction.walletAddress,
        transaction.transactionType,
        transaction.amount,
        transaction.pricePerToken,
        transaction.totalValue,
        new Date(transaction.blockTime * 1000),
        transaction.slot,
        transaction.blockHash,
        transaction.instructionIndex,
        transaction.innerInstructionIndex
      ]);

      const transactionId = insertTxResult.rows[0].id;

      // Update holder position
      await this.updateHolderPosition(
        client, 
        tokenId, 
        transaction.walletAddress, 
        transaction,
        transactionId
      );

      await client.query('COMMIT');
      
      logger.debug(`Successfully processed transaction: ${transaction.signature}`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error processing transaction ${transaction.signature}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ensure token exists in database, create if not
   */
  private async ensureTokenExists(client: any, tokenAddress: string): Promise<string> {
    // Check if token exists
    let result = await client.query(
      'SELECT id FROM tokens WHERE address = $1',
      [tokenAddress]
    );

    if (result.rows.length > 0) {
      return result.rows[0].id;
    }

    // Create new token record
    result = await client.query(`
      INSERT INTO tokens (address, status, created_at)
      VALUES ($1, 'tracking', NOW())
      RETURNING id
    `, [tokenAddress]);

    logger.info(`Created new token record: ${tokenAddress}`);
    return result.rows[0].id;
  }

  /**
   * Update holder position based on transaction
   */
  private async updateHolderPosition(
    client: any,
    tokenId: string,
    walletAddress: string,
    transaction: TokenTransaction,
    transactionId: string
  ): Promise<void> {
    // Get or create holder record
    let holderResult = await client.query(`
      SELECT id, current_balance, total_bought, total_sold, 
             average_buy_price, realized_pnl, first_buy_timestamp
      FROM holders 
      WHERE token_id = $1 AND wallet_address = $2
    `, [tokenId, walletAddress]);

    let holderId: string;
    let currentPosition: HolderPosition | null = null;

    if (holderResult.rows.length === 0) {
      // Create new holder
      holderResult = await client.query(`
        INSERT INTO holders (token_id, wallet_address, created_at)
        VALUES ($1, $2, NOW())
        RETURNING id, current_balance, total_bought, total_sold, 
                  average_buy_price, realized_pnl, first_buy_timestamp
      `, [tokenId, walletAddress]);
      
      holderId = holderResult.rows[0].id;
    } else {
      holderId = holderResult.rows[0].id;
      currentPosition = {
        id: holderId,
        tokenId,
        walletAddress,
        currentBalance: holderResult.rows[0].current_balance || '0',
        totalBought: holderResult.rows[0].total_bought || '0',
        totalSold: holderResult.rows[0].total_sold || '0',
        averageBuyPrice: holderResult.rows[0].average_buy_price || 0,
        unrealizedPnl: 0, // Will be calculated
        realizedPnl: holderResult.rows[0].realized_pnl || 0,
        firstBuyTimestamp: holderResult.rows[0].first_buy_timestamp,
        lastTransactionTimestamp: new Date(),
        isActive: true
      };
    }

    // Update position based on transaction type
    await this.updatePositionForTransaction(
      client,
      holderId,
      currentPosition,
      transaction,
      transactionId
    );
  }

  /**
   * Update position calculations based on transaction type
   */
  private async updatePositionForTransaction(
    client: any,
    holderId: string,
    currentPosition: HolderPosition | null,
    transaction: TokenTransaction,
    transactionId: string
  ): Promise<void> {
    const amount = new Big(transaction.amount);
    const price = new Big(transaction.pricePerToken);

    let newBalance = currentPosition ? new Big(currentPosition.currentBalance) : new Big(0);
    let newTotalBought = currentPosition ? new Big(currentPosition.totalBought) : new Big(0);
    let newTotalSold = currentPosition ? new Big(currentPosition.totalSold) : new Big(0);
    let newRealizedPnl = currentPosition ? new Big(currentPosition.realizedPnl) : new Big(0);

    switch (transaction.transactionType) {
      case 'buy':
        newBalance = newBalance.plus(amount);
        newTotalBought = newTotalBought.plus(amount);
        
        // Add to cost basis
        await this.costBasisCalculator.addPurchase(
          holderId,
          transactionId,
          amount.toString(),
          price.toNumber(),
          new Date(transaction.blockTime * 1000)
        );
        break;

      case 'sell':
        newBalance = newBalance.minus(amount);
        newTotalSold = newTotalSold.plus(amount);
        
        // Calculate realized P&L using FIFO
        const realizedPnl = await this.costBasisCalculator.processSale(
          holderId,
          amount.toString(),
          price.toNumber()
        );
        
        newRealizedPnl = newRealizedPnl.plus(realizedPnl);
        break;

      case 'transfer':
        // Handle transfers (could be in or out)
        // For now, treat as balance change without P&L impact
        newBalance = newBalance.plus(amount); // Positive for incoming, negative for outgoing
        break;
    }

    // Calculate new average buy price
    let newAverageBuyPrice = 0;
    if (newTotalBought.gt(0)) {
      const totalCostBasis = await this.costBasisCalculator.getTotalCostBasis(holderId);
      newAverageBuyPrice = totalCostBasis / parseFloat(newTotalBought.toString());
    }

    // Update holder record
    await client.query(`
      UPDATE holders SET
        current_balance = $1,
        total_bought = $2,
        total_sold = $3,
        average_buy_price = $4,
        realized_pnl = $5,
        first_buy_timestamp = COALESCE(first_buy_timestamp, CASE WHEN $6 = 'buy' THEN $7 ELSE NULL END),
        last_transaction_timestamp = $7,
        is_active = $1::BIGINT > 0,
        updated_at = NOW()
      WHERE id = $8
    `, [
      newBalance.toString(),
      newTotalBought.toString(),
      newTotalSold.toString(),
      newAverageBuyPrice,
      newRealizedPnl.toNumber(),
      transaction.transactionType,
      new Date(transaction.blockTime * 1000),
      holderId
    ]);

    logger.debug(`Updated holder position for ${transaction.walletAddress}`);
  }

  /**
   * Handle new token launch
   */
  private async handleTokenLaunch(launch: TokenLaunch): Promise<void> {
    try {
      logger.info(`Processing token launch: ${launch.symbol || launch.tokenAddress}`);

      const client = await this.db.connect();
      
      try {
        await client.query(`
          INSERT INTO tokens (
            address, symbol, name, decimals, mint_authority,
            launch_timestamp, total_supply, status, metadata, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'tracking', $8, NOW())
          ON CONFLICT (address) DO UPDATE SET
            symbol = EXCLUDED.symbol,
            name = EXCLUDED.name,
            decimals = EXCLUDED.decimals,
            mint_authority = EXCLUDED.mint_authority,
            launch_timestamp = EXCLUDED.launch_timestamp,
            total_supply = EXCLUDED.total_supply,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
        `, [
          launch.tokenAddress,
          launch.symbol,
          launch.name,
          launch.decimals,
          launch.mintAuthority,
          new Date(launch.launchTimestamp * 1000),
          launch.totalSupply,
          launch.metadata ? JSON.stringify(launch.metadata) : null
        ]);

        logger.info(`Successfully processed token launch: ${launch.tokenAddress}`);
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error processing token launch:', error);
    }
  }

  /**
   * Handle token graduation
   */
  private async handleTokenGraduation(graduationData: any): Promise<void> {
    try {
      logger.info(`Processing token graduation: ${graduationData.tokenAddress}`);

      const client = await this.db.connect();
      
      try {
        await client.query(`
          UPDATE tokens SET
            status = 'graduated',
            graduation_timestamp = $1,
            updated_at = NOW()
          WHERE address = $2
        `, [
          new Date(graduationData.graduationTimestamp * 1000),
          graduationData.tokenAddress
        ]);

        logger.info(`Successfully processed token graduation: ${graduationData.tokenAddress}`);
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error processing token graduation:', error);
    }
  }

  /**
   * Handle WebSocket connection
   */
  private handleConnection(): void {
    logger.info('Transaction processor: WebSocket connected');
  }

  /**
   * Handle WebSocket disconnection
   */
  private handleDisconnection(data: any): void {
    logger.warn('Transaction processor: WebSocket disconnected', data);
  }

  /**
   * Handle WebSocket errors
   */
  private handleError(error: Error): void {
    logger.error('Transaction processor: WebSocket error', error);
  }

  /**
   * Get processing statistics
   */
  public getStats(): {
    queueLength: number;
    isProcessing: boolean;
  } {
    return {
      queueLength: this.processingQueue.length,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Start processing historical data for a token
   */
  public async processHistoricalData(
    tokenAddress: string,
    fromTimestamp?: number
  ): Promise<void> {
    try {
      logger.info(`Starting historical data processing for ${tokenAddress}`);

      const client = getSolanaTrackerClient();
      const transactions = await client.getHistoricalTransactions(
        tokenAddress,
        fromTimestamp
      );

      logger.info(`Retrieved ${transactions.length} historical transactions for ${tokenAddress}`);

      // Sort transactions by block time to ensure correct order
      transactions.sort((a, b) => a.blockTime - b.blockTime);

      // Process each transaction
      for (const transaction of transactions) {
        await this.processTransaction(transaction);
      }

      logger.info(`Completed historical data processing for ${tokenAddress}`);
    } catch (error) {
      logger.error(`Error processing historical data for ${tokenAddress}:`, error);
      throw error;
    }
  }
}

// Export singleton instance
let transactionProcessor: TransactionProcessor;

export const getTransactionProcessor = (database: Pool): TransactionProcessor => {
  if (!transactionProcessor) {
    transactionProcessor = new TransactionProcessor(database);
  }
  return transactionProcessor;
};
