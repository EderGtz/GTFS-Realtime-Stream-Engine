import { connectToDatabase } from './db/connection.js';
import { pollVehiclePositions } from './ingestion/poller.js';

async function bootstrap() {
    await connectToDatabase();
    
    await pollVehiclePositions();
}

bootstrap();