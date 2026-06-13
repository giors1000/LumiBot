# MQTT Broker Setup (Production Requirement)

The app and blinds firmware communicate through a single MQTT broker. The PWA
derives its default browser broker host from the app host, while firmware takes
its default broker from `StepperMote/secrets.h`. A commercial deployment still
needs a stable broker hostname you control before units ship.

**Do not ship a unit until a broker you control is in place.**

## What production needs

1. **A stable hostname you own** such as `mqtt.yourdomain.com`.
2. **An MQTT broker with WebSocket support.** Mosquitto works well:

   ```conf
   # /etc/mosquitto/conf.d/zaylo.conf
   listener 1883
   listener 9001
   protocol websockets
   allow_anonymous false
   password_file /etc/mosquitto/passwd
   ```

3. **TLS in front of the WebSocket listener.** The PWA is served over HTTPS, so
   the browser requires `wss://`. A reverse proxy such as Caddy or nginx can
   terminate TLS on `wss://mqtt.yourdomain.com:443/mqtt` and forward to the
   Mosquitto WebSocket listener.
4. Optional but recommended: TLS on the device listener, for example port 8883,
   once firmware TLS support is enabled.

## Where endpoints are configured

| Component | Setting | Location |
|---|---|---|
| PWA | host / port / ws path / credentials | App host by default, or localStorage overrides `zaylo-BrokerIP`, `zaylo-BrokerPort`, `zaylo-BrokerPath`, `zaylo-BrokerUser`, `zaylo-BrokerPass` |
| Firmware | `SECRET_MQTT_BROKER`, `SECRET_MQTT_PORT`, `SECRET_MQTT_USER`, `SECRET_MQTT_PASS` | `StepperMote/secrets.h` for newly provisioned units |

## Migrating an already-shipped fleet

The firmware accepts a verified broker change over MQTT so units can be
repointed without physical access:

```json
// publish to lumibot/<DEVICE_ID>/config/set
{ "cmd": "change_broker", "broker": "mqtt.yourdomain.com", "port": 1883,
  "user": "lumibot", "pass": "<password>" }
```

Behaviour, implemented by `MqttManager::startBrokerChange`:

- The new broker is applied in RAM only and the device tries to connect.
- Only after a successful connection is it persisted to flash; the device then
  publishes `{"status":"success"}` on `lumibot/<ID>/broker-change-ack` on the
  new broker.
- If the new broker is unreachable for 60 seconds, the device rolls back to the
  previous broker and publishes `{"status":"failed"}` there. Flash is never
  touched on failure, so a power cut mid-migration is also safe.

Recommended cutover order:

1. Stand up the new broker and verify an app instance against it using the
   localStorage overrides.
2. Publish `change_broker` to each device on the old broker and confirm each
   one appears on the new broker.
3. Update `secrets.h` for newly provisioned firmware.
4. Configure the deployed PWA host or reverse proxy so `/mqtt` reaches the
   production broker.
5. Release the PWA and firmware, then decommission the old broker only after
   fleet telemetry confirms the migration.

## Known limitation

There is intentionally no hardcoded secondary broker in the codebase. A
failover list would just be more hardcoded infrastructure. The durable answer is
a hostname you control, since DNS can be repointed at a replacement broker
without touching devices.
