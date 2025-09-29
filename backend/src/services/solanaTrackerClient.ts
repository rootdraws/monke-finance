import WebSocket from 'ws';
import { EventEmitter } from 'events';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface TokenTransaction {
  signature: string;
  tokenAddress: string;
  walletAddress: string;
  transactionType: 'buy' | 'sell' | 'transfer';
  amount: string; // Token amount in smallest unit
  pricePerToken: number;
  totalValue: number;
  blockTime: number;
  slot: number;
  blockHash?: string;
  instructionIndex?: number;
  innerInstructionIndex?: number;
}

export interface TokenLaunch {
  tokenAddress: string;
  symbol?: string;
  name?: string;
  decimals: number;
  mintAuthority?: string;
  launchTimestamp: number;
  totalSupply?: string;
  metadata?: any;
}

export class SolanaTrackerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly restUrl: string;
  private readonly apiKey: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000; // Start with 1 second
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isConnected = false;
  private subscribedTokens = new Set<string>();

  constructor(apiKey: string, wsUrl: string, restUrl: string) {
    super();
    this.apiKey = apiKey;
    this.wsUrl = wsUrl;
    this.restUrl = restUrl;
  }

  /**
   * Connect to Solana Tracker WebSocket
   */
  public async connect(): Promise<void> {
    try {
      logger.info('Connecting to Solana Tracker WebSocket...');
      
      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'MONKE.finance/1.0.0'
        }
      });

      this.setupWebSocketHandlers();
      
      return new Promise((resolve, reject) => {
        if (!this.ws) {
          reject(new Error('WebSocket failed to initialize'));
          return;
        }

        this.ws.once('open', () => {
          logger.info('Connected to Solana Tracker WebSocket');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.startHeartbeat();
          resolve();
        });

        this.ws.once('error', (error) => {
          logger.error('WebSocket connection error:', error);
          reject(error);
        });

        // Timeout after 30 seconds
        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 30000);
      });
    } catch (error) {
      logger.error('Failed to connect to Solana Tracker:', error);
      throw error;
    }
  }

  /**
   * Set up WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      logger.info('WebSocket connection opened');
      this.isConnected = true;
      this.emit('connected');
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`WebSocket connection closed: ${code} - ${reason}`);
      this.isConnected = false;
      this.stopHeartbeat();
      this.emit('disconnected', { code, reason: reason.toString() });
      this.handleReconnection();
    });

    this.ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
      this.emit('error', error);
    });

    this.ws.on('message', (data) => {
      try {
        this.handleMessage(data.toString());
      } catch (error) {
        logger.error('Error processing WebSocket message:', error);
        this.emit('error', error);
      }
    });

    this.ws.on('ping', () => {
      logger.debug('Received ping from server');
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong();
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: string): void {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'transaction':
          this.handleTransaction(data.payload);
          break;
        case 'token_launch':
          this.handleTokenLaunch(data.payload);
          break;
        case 'token_graduation':
          this.handleTokenGraduation(data.payload);
          break;
        case 'heartbeat':
          this.handleHeartbeat(data.payload);
          break;
        case 'subscription_confirmed':
          logger.info(`Subscription confirmed for: ${data.payload.tokenAddress}`);
          break;
        case 'error':
          logger.error('Server error:', data.payload);
          this.emit('serverError', data.payload);
          break;
        default:
          logger.debug('Unknown message type:', data.type);
      }
    } catch (error) {
      logger.error('Error parsing WebSocket message:', error);
      logger.debug('Raw message:', message);
    }
  }

  /**
   * Handle transaction data
   */
  private handleTransaction(payload: any): void {
    try {
      const transaction: TokenTransaction = {
        signature: payload.signature,
        tokenAddress: payload.tokenAddress,
        walletAddress: payload.walletAddress,
        transactionType: payload.type,
        amount: payload.amount,
        pricePerToken: payload.pricePerToken,
        totalValue: payload.totalValue,
        blockTime: payload.blockTime,
        slot: payload.slot,
        blockHash: payload.blockHash,
        instructionIndex: payload.instructionIndex,
        innerInstructionIndex: payload.innerInstructionIndex
      };

      logger.debug(`Transaction received: ${transaction.transactionType} ${transaction.amount} tokens`);
      this.emit('transaction', transaction);
    } catch (error) {
      logger.error('Error processing transaction:', error);
    }
  }

  /**
   * Handle token launch data
   */
  private handleTokenLaunch(payload: any): void {
    try {
      const launch: TokenLaunch = {
        tokenAddress: payload.tokenAddress,
        symbol: payload.symbol,
        name: payload.name,
        decimals: payload.decimals,
        mintAuthority: payload.mintAuthority,
        launchTimestamp: payload.launchTimestamp,
        totalSupply: payload.totalSupply,
        metadata: payload.metadata
      };

      logger.info(`New token launch detected: ${launch.symbol || launch.tokenAddress}`);
      this.emit('tokenLaunch', launch);
    } catch (error) {
      logger.error('Error processing token launch:', error);
    }
  }

  /**
   * Handle token graduation data
   */
  private handleTokenGraduation(payload: any): void {
    try {
      logger.info(`Token graduated: ${payload.tokenAddress}`);
      this.emit('tokenGraduation', {
        tokenAddress: payload.tokenAddress,
        graduationTimestamp: payload.timestamp,
        finalPrice: payload.finalPrice,
        totalRaised: payload.totalRaised,
        poolAddress: payload.poolAddress
      });
    } catch (error) {
      logger.error('Error processing token graduation:', error);
    }
  }

  /**
   * Handle heartbeat from server
   */
  private handleHeartbeat(payload: any): void {
    logger.debug('Heartbeat received from server');
    this.emit('heartbeat', payload);
  }

  /**
   * Subscribe to a specific token's transaction stream
   */
  public subscribeToToken(tokenAddress: string): void {
    if (!this.isConnected || !this.ws) {
      logger.warn(`Cannot subscribe to ${tokenAddress}: WebSocket not connected`);
      return;
    }

    const subscriptionMessage = {
      type: 'subscribe',
      payload: {
        tokenAddress,
        includeTransactions: true,
        includeMetadata: true
      }
    };

    this.ws.send(JSON.stringify(subscriptionMessage));
    this.subscribedTokens.add(tokenAddress);
    logger.info(`Subscribed to token: ${tokenAddress}`);
  }

  /**
   * Unsubscribe from a token's stream
   */
  public unsubscribeFromToken(tokenAddress: string): void {
    if (!this.isConnected || !this.ws) {
      logger.warn(`Cannot unsubscribe from ${tokenAddress}: WebSocket not connected`);
      return;
    }

    const unsubscriptionMessage = {
      type: 'unsubscribe',
      payload: {
        tokenAddress
      }
    };

    this.ws.send(JSON.stringify(unsubscriptionMessage));
    this.subscribedTokens.delete(tokenAddress);
    logger.info(`Unsubscribed from token: ${tokenAddress}`);
  }

  /**
   * Subscribe to new token launches
   */
  public subscribeToNewLaunches(): void {
    if (!this.isConnected || !this.ws) {
      logger.warn('Cannot subscribe to new launches: WebSocket not connected');
      return;
    }

    const subscriptionMessage = {
      type: 'subscribe_launches',
      payload: {
        includeMetadata: true
      }
    };

    this.ws.send(JSON.stringify(subscriptionMessage));
    logger.info('Subscribed to new token launches');
  }

  /**
   * Get historical transaction data via REST API
   */
  public async getHistoricalTransactions(
    tokenAddress: string, 
    fromTimestamp?: number,
    limit = 1000
  ): Promise<TokenTransaction[]> {
    try {
      const params: any = {
        tokenAddress,
        limit
      };

      if (fromTimestamp) {
        params.from = fromTimestamp;
      }

      const response = await axios.get(`${this.restUrl}/transactions`, {
        params,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      return response.data.transactions.map((tx: any) => ({
        signature: tx.signature,
        tokenAddress: tx.tokenAddress,
        walletAddress: tx.walletAddress,
        transactionType: tx.type,
        amount: tx.amount,
        pricePerToken: tx.pricePerToken,
        totalValue: tx.totalValue,
        blockTime: tx.blockTime,
        slot: tx.slot,
        blockHash: tx.blockHash,
        instructionIndex: tx.instructionIndex,
        innerInstructionIndex: tx.innerInstructionIndex
      }));
    } catch (error) {
      logger.error('Error fetching historical transactions:', error);
      throw error;
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // Send ping every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Handle reconnection logic
   */
  private handleReconnection(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached. Giving up.');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
    
    logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(async () => {
      try {
        await this.connect();
        // Re-subscribe to all previously subscribed tokens
        for (const tokenAddress of this.subscribedTokens) {
          this.subscribeToToken(tokenAddress);
        }
      } catch (error) {
        logger.error('Reconnection failed:', error);
        this.handleReconnection();
      }
    }, delay);
  }

  /**
   * Disconnect from WebSocket
   */
  public disconnect(): void {
    logger.info('Disconnecting from Solana Tracker WebSocket');
    this.isConnected = false;
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.subscribedTokens.clear();
  }

  /**
   * Get connection status
   */
  public getConnectionStatus(): {
    isConnected: boolean;
    subscribedTokens: string[];
    reconnectAttempts: number;
  } {
    return {
      isConnected: this.isConnected,
      subscribedTokens: Array.from(this.subscribedTokens),
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// Export singleton instance
let solanaTrackerClient: SolanaTrackerClient;

export const getSolanaTrackerClient = (): SolanaTrackerClient => {
  if (!solanaTrackerClient) {
    const apiKey = process.env.SOLANA_TRACKER_API_KEY || '';
    const wsUrl = process.env.SOLANA_TRACKER_WS_URL || 'wss://api.solana-tracker.com/ws';
    const restUrl = process.env.SOLANA_TRACKER_REST_URL || 'https://api.solana-tracker.com';
    
    if (!apiKey) {
      throw new Error('SOLANA_TRACKER_API_KEY environment variable is required');
    }
    
    solanaTrackerClient = new SolanaTrackerClient(apiKey, wsUrl, restUrl);
  }
  
  return solanaTrackerClient;
};
