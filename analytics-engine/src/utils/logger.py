import logging
import os
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path


def get_logger(name: str) -> logging.Logger:
    """
    Configures and returns a logger.
    """
    logger = logging.getLogger(name)
    
    if logger.hasHandlers():
        return logger

    env = os.getenv('APP_ENV', 'development')
    log_level_str = os.getenv('LOG_LEVEL', 'INFO').upper()
    
    if env == 'test':
        logger.setLevel(logging.CRITICAL + 1)
        return logger
        
    logger.setLevel(getattr(logging, log_level_str, logging.INFO))
    
    formatter = logging.Formatter(
        fmt='[%(asctime)s] %(levelname)s (%(name)s): %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # Console view
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # File rotation
    log_dir = Path("logs")
    log_dir.mkdir(exist_ok=True)
    
    file_handler = TimedRotatingFileHandler(
        filename=log_dir / "analytics.log",
        when="midnight",         # Daily
        interval=1,
        backupCount=7,           # 7 files at max
        encoding="utf-8"
    )
    file_handler.suffix = "%d-%m-%Y.log" # Date format
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger