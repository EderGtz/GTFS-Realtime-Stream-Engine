import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

const targets: pino.TransportTargetOptions[] = [];

if (!isProd) {
    targets.push({
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            destination: 1
        }
    });
}

if (!isProd) {
    targets.push({
        target: 'pino-roll',
        options: {
            file: './logs/ingestion',
            mkdir: true,
            frequency: 'daily',
            dateFormat: 'dd-MM-yyyy',
            extension: '.log',
            limit: {
                count: 7
            },
        },
    });
}

const options: pino.LoggerOptions = {
    level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
};

if (targets.length > 0) {
    options.transport = { targets };
}

export const logger = pino(options);
