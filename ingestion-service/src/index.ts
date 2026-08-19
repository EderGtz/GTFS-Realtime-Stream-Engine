import { pollVehiclePositions } from './ingestion/poller.js';
import { logger } from './utils/logger.js';

async function bootstrap() {
    await pollVehiclePositions();
}

bootstrap().catch((err) => {
    logger.fatal({ err }, "Fatal error during bootstrap. Exiting");
    process.exit(1);
});