import pino, { destination } from 'pino';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    destination: 1
                }
            },
            {
                target: 'pino/file',
                options: {
                    destination: './logs/ingestion.log',
                    mkdir: true,
                }
            }
        ]
    }
});