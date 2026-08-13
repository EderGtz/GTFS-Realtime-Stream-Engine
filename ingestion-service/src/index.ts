import { connectToDatabase } from './db/connection.js';
import { pollVehiclePositions } from './ingestion/poller.js';
import { logger } from './utils/logger.js';

async function bootstrap() {
    // Mongo connection deferred to Phase 4
    // await connectToDatabase();
    await pollVehiclePositions();
}

bootstrap().catch((err) => {
    logger.fatal({ err }, "Fatal error during bootstrap. Exiting");
    process.exit(1);
});