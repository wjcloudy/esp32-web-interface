# MQTT

The module can publish spot values to an MQTT broker, so Home Assistant,
Node-RED or a logger can pick them up without polling the web interface.

## Setting it up

**Settings → Device & Connection → MQTT Broker** (admin only):

| Field | Notes |
| --- | --- |
| Broker host | An IP address, a DNS name, or a `.local` name (resolved over mDNS). |
| Port | 1883 by default. Plain TCP only: there is no TLS. |
| Username / password | Optional. The password is stored in the module's NVS, never in a file, and the web interface only shows whether one is set. Leave the field blank to keep it. |
| Client ID | Blank uses the hostname plus the end of the chip's MAC address, so two boards with the same name don't keep disconnecting each other. |
| Topic prefix | Blank uses `openinverter/<hostname>`. |
| Spot values | Comma-separated names, e.g. `udc, tmphs, speed`. Names the inverter's parameter list doesn't have are flagged as you type. |
| Every (s) | Publish interval, 1-3600 s. |
| Retain values | Sets the retain flag on value messages. |

The settings are kept in `settings.json`, so they survive firmware and
filesystem updates. **Reset settings** clears them, password included.

## Topics

- `<prefix>/<name>`: one message per value, e.g. `openinverter/inverter/udc` → `398.50`.
- `<prefix>/status`: `online` (retained) once connected. The broker publishes
  `offline` as the module's last will if the connection drops, and the module
  publishes it itself when MQTT is turned off.

Viewers can see the connection state on the same card (`GET /mqtt/status`),
including any configured names the inverter reported as unknown.

## How it behaves

- The MQTT client runs in its own task. A slow, missing or stalled broker
  delays only MQTT, never the web interface or the gauges. Failed connections
  retry after 5 s, doubling up to 60 s.
- Values are read from the inverter only while the broker is connected: one
  `get` per batch of names over UART (one reply line per name, so an unknown
  name costs only its own value), or one SDO read per name in CAN mode.
- Nothing is read or published while binary SD logging owns the UART, or
  while a CAN firmware update owns the bus.
