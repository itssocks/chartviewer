// GPS position + heading for the own-ship icon (situational awareness only).
//
// Which way the icon points:
//   - below 5 kt  : the iPad's compass (where the nose points). So during pushback
//                   or slow taxi it never shows you going backwards.
//   - 5 to 15 kt  : a smooth blend from compass to GPS track.
//   - above 15 kt : GPS track (the direction you're actually moving over the ground).
//   - if track and compass disagree by more than 100 deg (e.g. a faster pushback),
//     the compass wins.
//   - without a compass reading, the last good GPS track is kept; with neither,
//     the icon is a dot without direction.
// Compass readings are magnetic and relative to the top of the iPad; they're
// corrected for the screen orientation and the local magnetic variation.

const KT = 1.943844;
const SLOW = 5, FAST = 15;      // kt: blend range compass -> GPS track
const DISAGREE = 100;           // deg: track vs compass -> trust compass
const norm = (a) => ((a % 360) + 360) % 360;
const diff = (a, b) => ((b - a + 540) % 360) - 180; // signed shortest angle a->b

export class Gps {
  constructor(onChange) {
    this.onChange = onChange;
    this.watch = null;
    this.fix = null;          // { lat, lon, acc (m), kt, track (deg true) | null, time }
    this.compass = null;      // deg magnetic, screen-up corrected
    this.compassTime = 0;
    this.magvar = 0;          // deg, east positive (true = magnetic + magvar)
    this.heading = null;      // smoothed true heading shown on the icon
    this.headingSource = '';
    this.lastTrack = null;
    this.error = '';
    this._onOrient = (e) => this._orient(e);
  }

  get running() { return this.watch != null; }

  start() {
    if (this.running) return;
    if (!('geolocation' in navigator)) { this.error = 'GPS not available on this device'; this.onChange(); return; }
    this.error = '';
    this.watch = navigator.geolocation.watchPosition(
      (p) => this._pos(p),
      (e) => { this.error = e.code === 1 ? 'Location permission denied' : e.code === 3 ? 'Waiting for GPS…' : 'No GPS signal'; this.onChange(); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    window.addEventListener('deviceorientationabsolute', this._onOrient);
    window.addEventListener('deviceorientation', this._onOrient);
  }

  stop() {
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
    window.removeEventListener('deviceorientationabsolute', this._onOrient);
    window.removeEventListener('deviceorientation', this._onOrient);
    this.fix = null; this.heading = null; this.compass = null; this.error = '';
  }

  /** iOS needs a tap to allow the compass. Call from a click handler. */
  static async askCompass() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        return (await DeviceOrientationEvent.requestPermission()) === 'granted';
      }
    } catch { /* not allowed without a tap */ }
    return true;
  }

  _orient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) h = e.webkitCompassHeading; // iOS
    else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;                                   // others
    if (h == null) return;
    const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    this.compass = norm(h + angle);
    this.compassTime = Date.now();
    this._update();
  }

  _pos(p) {
    const c = p.coords;
    const kt = c.speed != null && c.speed >= 0 ? c.speed * KT : 0;
    const track = c.heading != null && !Number.isNaN(c.heading) && kt >= 3 ? c.heading : null;
    this.fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, kt, track, alt: c.altitude, time: p.timestamp };
    if (track != null && kt >= FAST * 0.6) this.lastTrack = track;
    this.error = '';
    this._update();
  }

  _update() {
    const f = this.fix;
    const compassTrue = this.compass != null && Date.now() - this.compassTime < 3000 ? norm(this.compass + this.magvar) : null;
    let target = null, src = '';
    const track = f?.track ?? null;
    const kt = f?.kt ?? 0;
    if (compassTrue != null && track != null) {
      let w = Math.min(1, Math.max(0, (kt - SLOW) / (FAST - SLOW)));
      if (Math.abs(diff(compassTrue, track)) > DISAGREE) w = 0;     // reversing / odd: trust the nose
      target = norm(compassTrue + diff(compassTrue, track) * w);
      src = w >= 1 ? 'track' : w <= 0 ? 'compass' : 'blend';
    } else if (track != null) {
      target = track; src = 'track';
    } else if (compassTrue != null) {
      target = compassTrue; src = 'compass';
    } else if (this.lastTrack != null) {
      target = this.lastTrack; src = 'last track';
    }
    if (target == null) { this.heading = null; this.headingSource = ''; }
    else {
      // smooth: move part of the way each update (compass updates come many times a second)
      // (GPS-only updates come about once a second, so they move further each time.)
      const k = src === 'track' || src === 'last track' ? 0.6 : 0.25;
      this.heading = this.heading == null ? target : norm(this.heading + diff(this.heading, target) * k);
      this.headingSource = src;
    }
    this.onChange();
  }
}

/** "W004.0" / "E002.5" (Jeppesen magnetic variation) -> degrees, east positive. */
export function parseMagvar(s) {
  const m = /^([EW])0*(\d+(?:\.\d+)?)/.exec(s || '');
  return m ? (m[1] === 'E' ? 1 : -1) * parseFloat(m[2]) : 0;
}
