import pino from 'pino';

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
                target: 'pino-roll',
                options: {
                    destination: './logs/ingestion',
                    mkdir: true,

                    frequency: 'daily',
                    extension: '.log',
                    limit: {
                        count: 7
                    }
                }
            }
        ]
    }
});