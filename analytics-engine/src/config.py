import os
from dataclasses import dataclass


@dataclass(frozen=True)
class AppConfig:
    kafka_brokers: str
    kafka_topic: str
    kafka_group_id: str
    mongo_uri: str

    @classmethod
    def from_env(cls) -> "AppConfig":
        try:
            return cls(
                kafka_brokers=os.environ["KAFKA_BROKERS"],
                kafka_topic=os.getenv("KAFKA_TOPIC", "raw.vehicle-positions"),
                kafka_group_id=os.getenv("KAFKA_GROUP_ID", "analytics-engine"),
                mongo_uri=os.environ["MONGO_URI"]
            )
        except KeyError as e:
            raise RuntimeError(f"Missing mandatory environment variable: {e}")