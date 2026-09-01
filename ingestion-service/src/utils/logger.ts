import pino from 'pino';

const targets: pino.TransportTargetOptions[] = [
    {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            destination: 1
        }
    }
];

if (process.env.NODE_ENV !== 'test') {
    targets.push({
        target: 'pino-roll',
        options: {
            file: './logs/ingestion',
            mkdir: true,
            frequency: 'daily',
            extension: '.log',
            limit: {
                count: 7
            }
        }
    });
}

export const logger = pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    transport: {
        targets
    }
});