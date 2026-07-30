import mongoose from 'mongoose';
import { config } from '../config.js';

export async function connectToDatabase() {
    try {
        await mongoose.connect(config.mongoUri);
        console.log('Successfully connected to MongoDB.');

    } catch (error) {
        console.error('Database connection failed:', error);
        process.exit(1);
    }
}