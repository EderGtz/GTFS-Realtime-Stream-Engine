import mongoose from 'mongoose';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export async function connectToDatabase() {
    try {
        await mongoose.connect(config.mongoUri);
        logger.info('Successfully connected to MongoDB.');

    } catch (error) {
        logger.error({ err: error }, 'Database connection failed');
        process.exit(1);
    }
}