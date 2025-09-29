# MONKE.finance Code Map

This document maps all the files created and their purposes. This is a **rough draft** that needs to be adjusted based on actual Solana Tracker API capabilities.

## 📁 Project Structure Overview

```
monke-finance/
├── backend/           # Node.js API server
├── frontend/          # React dashboard  
├── shared/            # Shared utilities (empty)
├── docs/              # Documentation (empty)
├── README.md          # Project documentation
└── .gitignore        # Git ignore rules
```

---

## 🗄️ Database Files

### `/backend/migrations/001-initial-schema.sql`
**Purpose**: Complete PostgreSQL database schema
**What it does**: 
- Creates 8 tables for token tracking, transactions, holders, cost basis, etc.
- **⚠️ ASSUMPTION**: Built without knowing actual API data structure
- May need significant changes based on real API format

**Key tables created**:
- `tokens` - Token metadata and status
- `transactions` - All buy/sell/transfer events  
- `holders` - Current token holder positions
- `cost_basis` - FIFO cost basis tracking for P&L
- `pool_data` - LP pool information
- `analytics_cache` - Pre-calculated data
- `stream_status` - Data collection monitoring

---

## ⚙️ Backend Service Files

### `/backend/src/services/solanaTrackerClient.ts`
**Purpose**: WebSocket client to connect to Solana Tracker API
**What it does**:
- Connects to WebSocket for real-time data
- **⚠️ ASSUMPTION**: Assumes specific message formats and event types
- Handles token launches, transactions, graduations
- Auto-reconnection and error handling

**Key assumptions made**:
- API sends `transaction`, `token_launch`, `token_graduation` events
- Specific data fields for each event type
- WebSocket authentication with Bearer token

### `/backend/src/services/transactionProcessor.ts` 
**Purpose**: Processes incoming transaction data and updates database
**What it does**:
- Takes transaction data from WebSocket
- **⚠️ ASSUMPTION**: Transaction format matches our database schema
- Updates holder positions and cost basis calculations
- Queue-based processing

**Key assumptions made**:
- Transaction has fields like: signature, walletAddress, amount, pricePerToken
- Can determine buy/sell/transfer types
- Price data is available per transaction

### `/backend/src/services/costBasisCalculator.ts`
**Purpose**: FIFO cost basis tracking for profit/loss analysis  
**What it does**:
- Implements First-In-First-Out accounting method
- **⚠️ ASSUMPTION**: We can track individual purchase lots
- Calculates realized/unrealized P&L
- Holder psychology analysis (profit/loss zones)

**Key assumptions made**:
- Can track when each token was purchased and at what price
- Can match sales to specific purchase lots
- Price history is available

### `/backend/src/utils/logger.ts`
**Purpose**: Logging system for debugging and monitoring
**What it does**:
- Winston-based logging to console and files
- Different log levels (debug, info, warn, error)
- **✅ SOLID**: This should work regardless of API format

---

## 🔧 Configuration Files

### `/backend/.env.example`
**Purpose**: Template for environment variables
**What it contains**:
- Database connection settings
- **⚠️ ASSUMPTION**: Solana Tracker API key and URLs
- JWT secrets, Redis config, etc.

### `/frontend/.env.example` 
**Purpose**: Frontend environment template
**What it contains**:
- API endpoints
- **⚠️ ASSUMPTION**: TradingView integration settings
- Feature flags

### `/backend/package.json` & `/frontend/package.json`
**Purpose**: Node.js dependencies
**What they contain**:
- All required npm packages
- **✅ MOSTLY SOLID**: Libraries should work, but may need different ones based on API

---

## 🎯 What We Need to Verify with Real API

### 1. **Data Structure**
- What fields does each transaction actually have?
- How are token launches reported?
- What price/volume data is available?

### 2. **API Capabilities** 
- Is it WebSocket or REST only?
- What authentication is required?
- Rate limits and data availability?

### 3. **Historical Data**
- Can we get complete transaction history for tokens?
- How far back does data go?
- Are prices included or do we need external price feeds?

### 4. **Real-time Updates**
- What events are pushed in real-time?
- Message format and frequency?
- Connection stability and reconnection handling?

---

## 🚨 Critical Assumptions Made

**⚠️ Database Schema**: Built tables assuming we can get:
- Individual transaction details with prices
- Wallet addresses for each transaction  
- Token metadata (symbol, name, decimals)
- Graduation events with pool information

**⚠️ WebSocket Format**: Assumed specific message types and data structure

**⚠️ Cost Basis Tracking**: Assumed we can track individual purchase lots for FIFO calculations

**⚠️ Price Data**: Assumed price per token is available for each transaction

---

## ✅ What Should Still Work

- **Project structure**: Modular, professional organization
- **Database design concepts**: Tables and relationships make sense
- **Error handling and logging**: Professional development practices  
- **Configuration management**: Environment-based setup
- **Code organization**: Services, utilities, proper TypeScript

---

## 🔄 Next Steps

1. **Get real API documentation/examples**
2. **Adjust database schema** to match actual data fields
3. **Update WebSocket client** to handle real message formats  
4. **Modify transaction processor** to work with available data
5. **Test with real API calls** to validate our assumptions

The foundation is solid, but we need to align it with reality! 🎯
