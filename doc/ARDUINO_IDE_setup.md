Arduino IDE setup
=================

# Table of Contents
<details>
 <summary>Click to open TOC</summary>
<!-- MarkdownTOC autolink="true" levels="1,2,3,4,5,6" bracket="round" style="unordered" indent="    " autoanchor="false" markdown_preview="github" -->

- [About Arduino IDE](#about-arduino-ide)
- [Installing Arduino IDE and plugins](#installing-arduino-ide-and-plugins)
- [Configuring Arduino IDE](#configuring-arduino-ide)

<!-- /MarkdownTOC -->
</details>

# About Arduino IDE

Arduino IDE is an open-source integrated development environment with support for multiple platforms.  

Learn more : https://www.arduino.cc/en/software

# Installing Arduino IDE and plugins

[Download](https://www.arduino.cc/en/software#download) the IDE, and follow the [Getting Started](https://www.arduino.cc/en/Guide)
guide.

> **Note:** PlatformIO is the primary, fully-supported toolchain for this project — it runs the version-stamping and asset-gzip build steps automatically (see [PLATFORMIO_setup.md](PLATFORMIO_setup.md) / [PLATFORMIO_usage.md](PLATFORMIO_usage.md)). The Arduino IDE path below is provided as a convenience.

Additionally, install the ESP32 filesystem-upload plugin so you can flash the web interface files in `data/`:
* https://github.com/espressif/arduino-esp32fs-plugin

When you start the Arduino IDE, you should now have an additional option in the `Tools` menu:
* ESP32 Sketch Data Upload

# Configuring Arduino IDE

In the `Preferences` pane for the IDE, look for `Additional Boards Manager URLs`, click on the button on the right, and append the following URL:
`https://espressif.github.io/arduino-esp32/package_esp32_index.json`

In the `Tools` menu, select the `Board` entry, click on the `Boards Manager...` submenu, enter `esp32` in the search box and press Enter.

You should have one entry named `esp32 by Espressif Systems` ; click on `Install` and wait for installation.

Open the project `File` > `Open` and navigate to the `esp32-web-interface.ino` file, and open it.

Go back to the `Tools` menu, and in the `Board` entry under `ESP32 Arduino` choose your board (`ESP32 Dev Module` for a classic ESP32; an ESP32-S3 board for the LILYGO T-2Can).

Configure the other parameters the following way:

* Upload Speed : 921600
* Flash Size: 4MB (16MB for the LILYGO T-2Can)
* Partition Scheme: a scheme with a SPIFFS partition (e.g. `Default 4MB with spiffs`; `16M Flash (3MB APP/9.9MB FATFS)` or similar on the T-2Can)
* PSRAM: Enabled on boards that have it (e.g. the T-2Can), otherwise Disabled
* Core Debug Level: None (the serial port is attached to the inverter in normal operation)
* Port: (_lookup the port on which your USB/Serial adapter is. You can also choose the board if it's up, connected to your WiFi, for OTA flashing_)

That's it ! Your IDE should now be configured for your day to day operations.
