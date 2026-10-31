// Demo data: one made-up but plausible vehicle, shared by the live demo
// (demo/demo-esp.js, published to GitHub Pages) and the README screenshots
// (tests/screenshots/capture.mjs drives that same demo site).
//
// A ZombieVerter-style VCU in a converted car with a Nissan Leaf drive unit and
// a 96s pack, out on a drive. The names follow the bundled gauge layouts
// (data/gauges-sample.json) so every sample page has live values. It is
// demonstration data, not a copy of any real firmware's parameter list.
//
// Everything time-varying is a pure function of the simulated time in seconds,
// so a frozen clock (Playwright's page.clock) gives the same picture every run.
(function (root) {
  'use strict';

  // name: [category, unit, value, min, max, default]
  const PARAMS = {
    Inverter:       ['General Setup', '0=None, 1=Leaf_Gen1, 2=GS450H, 3=UserCAN, 4=OpenSource, 5=Prius_Gen3, 6=Outlander, 7=GS300H', 1, 0, 7, 0],
    Vehicle:        ['General Setup', '0=BMW_E46, 1=BMW_E65, 2=Classic, 3=None, 4=BMW_E39, 5=VAG, 6=Subaru', 2, 0, 6, 0],
    Transmission:   ['General Setup', '0=Manual, 1=Auto', 0, 0, 1, 0],
    BMS_Mode:       ['General Setup', '0=Off, 1=SimpBMS, 2=TiDaisychain, 3=LeafBMS, 4=RenaultKangoo33', 1, 0, 4, 0],
    ShuntType:      ['General Setup', '0=None, 1=ISA, 2=SBOX, 3=VAG', 1, 0, 3, 0],
    MotActive:      ['General Setup', '0=Mg1and2, 1=Mg1, 2=Mg2, 3=BlendingMG2and1', 0, 0, 3, 0],
    udcmin:         ['Battery', 'V', 288, 0, 1000, 450],
    udcmax:         ['Battery', 'V', 403, 0, 1000, 520],
    udclim:         ['Battery', 'V', 405, 0, 1000, 540],
    udcsw:          ['Battery', 'V', 300, 0, 1000, 330],
    cellmax:        ['Battery', 'mV', 4180, 0, 5000, 4200],
    cellmin:        ['Battery', 'mV', 3000, 0, 5000, 3000],
    BattCap:        ['Battery', 'kWh', 40, 0, 250, 22],
    potmin:         ['Throttle', 'dig', 520, 0, 4095, 0],
    potmax:         ['Throttle', 'dig', 3410, 0, 4095, 4095],
    pot2min:        ['Throttle', 'dig', 260, 0, 4095, 4095],
    pot2max:        ['Throttle', 'dig', 1705, 0, 4095, 4095],
    potmode:        ['Throttle', '0=SingleChannel, 1=DualChannel', 1, 0, 1, 0],
    dirmode:        ['Throttle', '0=Button, 1=Switch, 2=ButtonReversed, 3=SwitchReversed, 4=DefaultForward', 1, 0, 4, 1],
    regenlevel:     ['Throttle', '', 2, 0, 3, 2],
    regenmax:       ['Throttle', '%', -35, -100, 0, -30],
    regenrpm:       ['Throttle', 'rpm', 1500, 100, 10000, 1500],
    throtmax:       ['Throttle', '%', 100, 0, 100, 100],
    throtramp:      ['Throttle', '%/10ms', 4, 1, 100, 10],
    revlim:         ['Motor', 'rpm', 9500, 0, 20000, 6000],
    tmphsmax:       ['Motor', '°C', 85, 50, 150, 85],
    tmpmmax:        ['Motor', '°C', 130, 70, 300, 150],
    Pwrspnt:        ['Charger Control', 'W', 6600, 0, 12000, 1500],
    CCS_SOCLim:     ['Charger Control', '%', 90, 0, 100, 80],
    Chgctrl:        ['Charger Control', '0=Enable, 1=Disable, 2=Timer', 0, 0, 2, 0],
    ChgAcVolt:      ['Charger Control', 'V', 230, 0, 260, 240],
    ChgEff:         ['Charger Control', '%', 92, 0, 100, 90],
    BMS_BalancingOn:['BMS', '0=Off, 1=On', 0, 0, 1, 0],
    BMS_DTCRead:    ['BMS', '0=Idle, 1=Read', 0, 0, 1, 0],
    BMS_VminLimit:  ['BMS', 'V', 3.1, 0, 10, 3],
    BMS_VmaxLimit:  ['BMS', 'V', 4.18, 0, 10, 4.2],
    BMS_TminLimit:  ['BMS', '°C', 5, -100, 100, 5],
    BMS_TmaxLimit:  ['BMS', '°C', 50, -100, 100, 50],
    DCSetPnt:       ['DC-DC Converter', 'V', 14, 9, 15, 14],
    HeatPercnt:     ['Heater', '%', 60, 0, 100, 0],
    Set_Day:        ['Clock', '0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat', 6, 0, 6, 0],
    Set_Hour:       ['Clock', 'Hours', 10, 0, 23, 0],
    Set_Min:        ['Clock', 'Mins', 30, 0, 59, 0],
  };

  // name: unit (enum units carry their value labels, like the firmware's json)
  const SPOT = {
    version:      '4=2.30.A',
    opmode:       '0=Off, 1=Run, 2=Precharge, 3=PchFail, 4=Charge',
    status:       '0=None, 1=UdcLow, 2=UdcHigh, 4=UdcBelowUdcSw, 8=UdcLim, 16=EmcyStop, 32=MProt, 64=PotPressed, 128=TmpHs, 256=WaitStart, 512=BrakeCheck, 1024=CanCrc, 2048=CanCounter, 4096=PrechargeTimeout, 8192=HwShutdown',
    lasterr:      '0=NONE, 1=OVERCURRENT, 2=THROTTLE1, 3=THROTTLE2, 4=CANTIMEOUT, 5=EMCYSTOP, 6=MPROT, 7=DESAT, 8=OVERVOLTAGE',
    chgtyp:       '0=Off, 1=AC, 2=DCFC',
    dir:          '-1=Reverse, 0=Neutral, 1=Forward',
    GearFB:       '0=LOW, 1=HIGH, 2=AUTO',
    cruisestt:    '0=None, 1=On, 2=Set, 4=Resume, 8=Decel',
    canio:        '0=None, 1=Cruise, 2=Start, 4=Brake, 8=Forward, 16=Reverse, 32=BMS',
    udc:          'V',
    INVudc:       'V',
    idc:          'A',
    power:        'kW',
    deltaV:       'V',
    uaux:         'V',
    SOC:          '%',
    KWh:          'kWh',
    AMPh:         'Ah',
    speed:        'rpm',
    Veh_Speed:    'km/h',
    torque:       'Nm',
    TorqDerate:   'Nm',
    pot:          'dig',
    pot2:         'dig',
    potnom:       '%',
    tmphs:        '°C',
    tmpm:         '°C',
    BMS_Vmin:     'V',
    BMS_Vmax:     'V',
    BMS_CellDelta:'mV',
    BMS_Tmin:     '°C',
    BMS_Tmax:     '°C',
    BMS_Tavg:     '°C',
    ChgTemp:      '°C',
    AC_Volts:     'V',
    AC_Amps:      'A',
    PilotLim:     'A',
    CableLim:     'A',
    ChgT:         'min',
    PlugDet:      '0=Off, 1=On',
    hvChg:        '0=Off, 1=On',
    din_forward:  '0=Off, 1=On',
    din_reverse:  '0=Off, 1=On',
    din_brake:    '0=Off, 1=On',
    din_start:    '0=Off, 1=On',
    din_mprot:    '0=Off, 1=On',
    din_emcystop: '0=Off, 1=On',
    din_bms:      '0=Off, 1=On',
    din_HVreq:    '0=Off, 1=On',
    T15Stat:      '0=Off, 1=On',
    handbrk:      '0=Off, 1=On',
    cpuload:      '%',
  };

  const r2 = (v) => Math.round(v * 100) / 100;

  // A relaxed drive on a smooth, never-repeating-looking curve: sums of sines
  // with unrelated periods. t is seconds since the demo started.
  function simulate(t) {
    const s = Math.sin;
    const throttle = Math.max(-28, Math.min(96,
      38 + 30 * s(t / 7.3) + 18 * s(t / 2.9 + 1.1) + 9 * s(t / 1.3 + 0.4)));
    const rpm = Math.max(0, 3600 + 1900 * s(t / 9.1 - 0.6) + 600 * s(t / 3.7 + 0.8));
    const torque = throttle * 2.5;
    const idc = 3 + throttle * (throttle >= 0 ? 1.65 : 1.1); // drive draws, regen charges
    const soc = 78.4 - t * 0.002;
    const ocv = 352 + (soc - 50) * 0.5;
    const udc = ocv - idc * 0.11;
    const tmphs = 41 + 4 * (1 - Math.exp(-t / 400)) + 0.6 * s(t / 23);
    const tmpm = 56 + 7 * (1 - Math.exp(-t / 600)) + 0.8 * s(t / 31 + 2);
    const vmin = udc / 96 - 0.012 + 0.003 * s(t / 5);
    const vmax = udc / 96 + 0.009 + 0.002 * s(t / 6 + 1);
    // power: discharge reads negative, as the sample Power gauge (-300..50) expects
    const pot = 520 + (Math.max(0, throttle) / 100) * (3410 - 520);
    return {
      version: 4, opmode: 1, status: 0, lasterr: 0, chgtyp: 0, dir: 1, GearFB: 1, cruisestt: 0, canio: 8,
      udc: r2(udc), INVudc: r2(udc - 0.8), idc: r2(idc), power: r2(-udc * idc / 1000), deltaV: r2(ocv - udc),
      uaux: r2(13.9 + 0.08 * s(t / 4)), SOC: r2(soc), KWh: r2(12.6 + t * 0.0009), AMPh: r2(35.8 + t * 0.0025),
      speed: Math.round(rpm), Veh_Speed: r2(rpm * 0.0154), torque: r2(torque), TorqDerate: 250,
      pot: Math.round(pot), pot2: Math.round(pot / 2), potnom: r2(throttle),
      tmphs: r2(tmphs), tmpm: r2(tmpm),
      BMS_Vmin: r2(vmin * 1000) / 1000, BMS_Vmax: r2(vmax * 1000) / 1000, BMS_CellDelta: Math.round((vmax - vmin) * 1000),
      BMS_Tmin: 21, BMS_Tmax: 24, BMS_Tavg: r2(22.5 + 0.2 * s(t / 40)),
      ChgTemp: 19, AC_Volts: 0, AC_Amps: 0, PilotLim: 0, CableLim: 0, ChgT: 0, PlugDet: 0, hvChg: 0,
      din_forward: 1, din_reverse: 0, din_brake: throttle < 0 ? 1 : 0, din_start: 0, din_mprot: 1, din_emcystop: 1,
      din_bms: 1, din_HVreq: 1, T15Stat: 1, handbrk: 0,
      cpuload: r2(31 + 3 * s(t / 3.3)),
    };
  }

  // SPIFFS files the demo device starts with
  const FILES = {
    'favorites.json': { p: ['potmin', 'potmax', 'regenmax', 'udcmin', 'udcmax'], s: ['udc', 'idc', 'speed', 'potnom', 'tmphs', 'tmpm', 'SOC'] },
    'plots.json': {
      maxValues: 300, burstLength: 1,
      plots: [
        { id: 1, items: [{ name: 'speed', axis: 'left' }, { name: 'torque', axis: 'right' }, { name: 'potnom', axis: 'right' }] },
        { id: 2, items: [{ name: 'udc', axis: 'left' }, { name: 'idc', axis: 'right' }] },
      ],
    },
    'presets.json': {
      v: 1,
      presets: [
        { id: 1, name: 'Valet (gentle)', params: { throtmax: 40, regenmax: -15, revlim: 5000 } },
        { id: 2, name: 'Track day', params: { throtmax: 100, regenmax: -45, revlim: 9500 } },
      ],
    },
    'uiprefs.json': { theme: 'system', accentColor: '', dashMetrics: ['udc', 'idc', 'speed', 'tmpm', 'SOC'] },
    'virtualvals.json': {
      items: [
        { name: 'v_HeaterPwr', unit: 'W', id: 0x398, pos: 0, len: 16, gain: 1, offset: 0, signed: false },
        { name: 'v_OutsideT', unit: '°C', id: 0x54C, pos: 8, len: 8, gain: 0.5, offset: -40, signed: false },
      ],
    },
  };

  // CAN mode: the mappings the device reports, by parameter name
  const CAN_MAP = [
    { isrx: false, cobid: 0x3E8, name: 'udc', position: 0, length: 16, gain: 10, offset: 0 },
    { isrx: false, cobid: 0x3E8, name: 'idc', position: 16, length: 16, gain: 10, offset: 0 },
    { isrx: false, cobid: 0x3E8, name: 'SOC', position: 32, length: 8, gain: 1, offset: 0 },
    { isrx: false, cobid: 0x3E9, name: 'speed', position: 0, length: 16, gain: 1, offset: 0 },
    { isrx: false, cobid: 0x3E9, name: 'tmpm', position: 16, length: 8, gain: 1, offset: 40 },
    { isrx: true, cobid: 0x1DB, name: 'BMS_Vmin', position: 0, length: 16, gain: 0.001, offset: 0 },
    { isrx: true, cobid: 0x1DB, name: 'BMS_Vmax', position: 16, length: 16, gain: 0.001, offset: 0 },
  ];

  root.OI_DEMO_DATA = {
    PARAMS, SPOT, FILES, CAN_MAP, simulate,
    deviceName: 'Demo Roadster',
    webVersion: 'v1.12',
    repo: 'https://github.com/wjcloudy/esp32-web-interface',
    wifi: { staSSID: 'garage-wifi', apSSID: 'inverter', ip: '192.168.1.42', rssi: -58 },
    // Releases the demo's Update tab lists (stand-ins for the GitHub API)
    releases: ['v1.12', 'v1.11', 'v1.10'],
  };
})(typeof window !== 'undefined' ? window : globalThis);
