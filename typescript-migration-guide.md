# TypeScript Migration Guide — Zaylo Remote

## Overview

This document outlines the strategy for incrementally migrating `zaylo-remote` from vanilla JavaScript to TypeScript, providing type safety, better IDE support, and reduced bugs.

## Migration Priority

Migrate in dependency order. Start with leaf modules (no imports from other project files) and work upward.

### Phase 1: Core Utilities (Week 1)
| File | Rename | Notes |
|------|--------|-------|
| `state-store.js` | `state-store.ts` | Define `DeviceState` interface, typed `subscribe<T>()` |
| `automation-engine.js` | `automation-engine.ts` | Define `WeatherData`, `BlindSavedState` interfaces |

### Phase 2: Services (Week 2)
| File | Rename | Notes |
|------|--------|-------|
| `device-service.js` | `device-service.ts` | Type Firestore device documents |
| `home-service.js` | `home-service.ts` | Type home/user relationships |
| `auth.js` | `auth.ts` | Wrap Firebase Auth with typed helpers |
| `mqtt.js` | `mqtt.ts` | Define `MQTTPayload`, `DeviceCommand` types |

### Phase 3: Page Logic (Week 3)
| File | Rename | Notes |
|------|--------|-------|
| `blind-device.js` | `blind-device.ts` | Extract `BlindState` interface, typed event handlers |
| `app.js` | `app.ts` | Dashboard logic with typed device list |

## Key Interfaces to Define

```typescript
// state-store.ts
interface DeviceState {
  _online?: boolean;
  position?: number;
  blindPosition?: number;
  targetPosition?: number;
  isMoving?: boolean;
  isCalibrated?: boolean;
  linkedDeviceId?: string;
  linkedDeviceOnline?: boolean;
  motion?: boolean;
  still?: boolean;
  sunriseTime?: number;
  sunsetTime?: number;
  config?: BlindConfig;
  rules?: AutomationRules;
}

interface BlindConfig {
  openDuration: number;
  closeDuration: number;
  sunsetOffset: number;
  sunsetTarget: number;
  motionTimeout: number;
  presenceTarget: number;
  morningTime: string;
  morningDuration: number;
  morningTarget: number;
  morningDays: MorningDay[] | null;
  nightTime: string;
  nightTarget: number;
  tempThreshold: number;
  tempTarget: number;
  lat: number | null;
  lon: number | null;
  stepperTop?: number;
  stepperBottom?: number;
  stepperOpenSpeed: number;
  stepperCloseSpeed: number;
  stepperRelaxSteps: number;
  stepperStopDelay: number;
  stepperAcceleration: number;
}

interface MorningDay {
  enabled: boolean;
  time: string;
  duration: number;
  target: number;
}

interface AutomationRules {
  sunset: boolean;
  presence: boolean;
  morningOpen: boolean;
  nightLock: boolean;
  temperature: boolean;
}
```

## Build Setup

```bash
# Install TypeScript
npm install --save-dev typescript

# tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": false,
    "outDir": "./dist",
    "rootDir": "./src",
    "allowJs": true,           // Allow mixed JS/TS during migration
    "checkJs": false,          // Don't type-check JS files yet
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

## Migration Steps Per File

1. **Rename** `.js` → `.ts`
2. **Add type annotations** to function parameters and return types
3. **Define interfaces** for data structures
4. **Fix type errors** — the compiler will catch real bugs
5. **Run tests** to verify behavior is unchanged
6. **Update imports** in dependent files

## Compatibility Notes

- Use `allowJs: true` during migration so TS and JS files coexist
- Global declarations (e.g., `MQTTClient`, `StateStore`) need `declare const` in a `globals.d.ts` file until fully migrated
- Firebase SDK types available via `@types/firebase` if using compat layer
