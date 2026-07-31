import mongoose from 'mongoose';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export async function connectToDatabase() {
    try {
        await mongoose.connect(config.mongoUri);
        logger.info('Successfully connected to MongoDB.');

    } catch (error) {
        console.error('Database connection failed:', error);
        process.exit(1);
    }
}