CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'operator')) DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('controller', 'camera')),
  online boolean NOT NULL DEFAULT false,
  last_seen timestamptz,
  rssi integer,
  uptime_seconds bigint,
  firmware_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS garage_state (
  device_id text PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED', 'UNKNOWN', 'OFFLINE', 'ERROR')),
  closed_sensor boolean NOT NULL DEFAULT false,
  open_sensor boolean NOT NULL DEFAULT false,
  obstruction_sensor boolean,
  requested_action text,
  last_changed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS garage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  detail text NOT NULL,
  image_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_telemetry (
  id bigserial PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  rssi integer,
  uptime_seconds bigint,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commands (
  command_id uuid PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id),
  action text NOT NULL CHECK (action IN ('OPEN', 'CLOSE', 'STOP')),
  status text NOT NULL CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'FAILED')),
  result text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id text NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (reason IN ('MOTION', 'DOOR_OPENED', 'DOOR_CLOSED', 'MANUAL')),
  storage_key text NOT NULL,
  public_url text NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS garage_events_created_at_idx ON garage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_recorded_at_idx ON device_telemetry (recorded_at DESC);
CREATE INDEX IF NOT EXISTS camera_images_captured_at_idx ON camera_images (captured_at DESC);
