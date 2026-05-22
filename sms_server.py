#!/usr/bin/env python3
"""
TradeRep Pro — SMS Proxy Server
================================
Designed for Railway deployment. Flutter POSTs to this server,
which either simulates a send (MOCK_MODE=true) or calls Twilio (MOCK_MODE=false).
Credentials never touch the Flutter frontend.

─── Configuration (set as Railway environment variables) ───────────────────────
  MOCK_MODE=true              # Set to false to use real Twilio
  TWILIO_ACCOUNT_SID=ACxxx   # From Twilio Console
  TWILIO_AUTH_TOKEN=xxx       # From Twilio Console
  TWILIO_PHONE_NUMBER=+1xxx   # Your Twilio number in E.164 format
  GOOGLE_REVIEW_LINK=https://g.page/r/your-real-link/review
  PORT=8080                   # Set automatically by Railway — do not override

─── API Endpoints ──────────────────────────────────────────────────────────────
  POST /sms/send         — Send an SMS (mock or live)
  GET  /sms/status/{id}  — Get status of a sent message
  GET  /sms/log          — Get all sent messages this session
  GET  /health           — Health check + mode indicator

─── To switch to live Twilio ────────────────────────────────────────────────────
  In Railway dashboard → Variables:
    MOCK_MODE=false
    TWILIO_ACCOUNT_SID=ACxxxxxxxx
    TWILIO_AUTH_TOKEN=xxxxxxxx
    TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
  Then redeploy — no code changes needed.
"""

import json
import os
import sys
import uuid
import random
import logging
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('sms_server')

# ─── Configuration ────────────────────────────────────────────────────────────
def load_dotenv(path='.env'):
    """Simple .env loader — no external deps needed."""
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

# Railway injects PORT automatically — always read from env
PORT                = int(os.environ.get('PORT', 8080))
MOCK_MODE           = os.environ.get('MOCK_MODE', 'true').lower() != 'false'
ACCOUNT_SID         = os.environ.get('TWILIO_ACCOUNT_SID', '')
AUTH_TOKEN          = os.environ.get('TWILIO_AUTH_TOKEN', '')
TWILIO_PHONE        = os.environ.get('TWILIO_PHONE_NUMBER', '')
GOOGLE_REVIEW_LINK  = os.environ.get('GOOGLE_REVIEW_LINK', 'https://g.page/r/review')

# In-memory SMS log — persists for the lifetime of the Railway container
# Wire to Firestore or Postgres for permanent persistence
_sms_log: list[dict] = []

# ─── Mock Send ────────────────────────────────────────────────────────────────
def mock_send(to: str, body: str, job_id: str, template_key: str,
              customer_name: str, sms_type: str) -> dict:
    """Simulates a Twilio send. Returns a Twilio-shaped response dict."""
    success = random.random() < 0.90  # 90% simulated delivery rate
    mock_sid = f'MOCK_{uuid.uuid4().hex[:20].upper()}'

    record = {
        'id':            str(uuid.uuid4()),
        'sid':           mock_sid,
        'job_id':        job_id,
        'customer_name': customer_name,
        'to':            to,
        'from':          TWILIO_PHONE or '(mock)',
        'body':          body,
        'type':          sms_type,
        'template_key':  template_key,
        'status':        'delivered' if success else 'undelivered',
        'is_mock':       True,
        'error':         None if success else 'Simulated delivery failure',
        'sent_at':       datetime.now(timezone.utc).isoformat(),
    }
    _sms_log.append(record)
    log.info(f'[MOCK] {"✅" if success else "❌"} SMS to {to} | {template_key} | {mock_sid}')
    return record


# ─── Live Twilio Send ─────────────────────────────────────────────────────────
def live_send(to: str, body: str, job_id: str, template_key: str,
              customer_name: str, sms_type: str) -> dict:
    """Calls real Twilio REST API."""
    try:
        from twilio.rest import Client  # type: ignore
    except ImportError:
        raise RuntimeError('twilio package not installed — add it to requirements.txt')

    if not ACCOUNT_SID or not AUTH_TOKEN:
        raise RuntimeError('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set')

    if not TWILIO_PHONE:
        raise RuntimeError('TWILIO_PHONE_NUMBER must be set')

    client = Client(ACCOUNT_SID, AUTH_TOKEN)
    msg = client.messages.create(body=body, from_=TWILIO_PHONE, to=to)

    record = {
        'id':            str(uuid.uuid4()),
        'sid':           msg.sid,
        'job_id':        job_id,
        'customer_name': customer_name,
        'to':            to,
        'from':          TWILIO_PHONE,
        'body':          body,
        'type':          sms_type,
        'template_key':  template_key,
        'status':        msg.status,
        'is_mock':       False,
        'error':         None,
        'sent_at':       datetime.now(timezone.utc).isoformat(),
    }
    _sms_log.append(record)
    log.info(f'[TWILIO] ✅ SMS to {to} | SID: {msg.sid} | Status: {msg.status}')
    return record


# ─── HTTP Handler ─────────────────────────────────────────────────────────────
class SmsHandler(BaseHTTPRequestHandler):

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, status: int, data: dict):
        body = json.dumps(data, default=str).encode()
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b'{}'
        return json.loads(raw)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path.rstrip('/')

        if path == '/health':
            self._json(200, {
                'status':             'ok',
                'service':            'TradeRep Pro SMS API',
                'mock_mode':          MOCK_MODE,
                'twilio_configured':  bool(ACCOUNT_SID and AUTH_TOKEN and TWILIO_PHONE),
                'messages_sent':      len(_sms_log),
                'google_review_link': GOOGLE_REVIEW_LINK,
            })

        elif path == '/sms/log':
            self._json(200, {'messages': _sms_log, 'total': len(_sms_log)})

        elif path.startswith('/sms/status/'):
            msg_id = path.split('/')[-1]
            record = next(
                (m for m in _sms_log if m['id'] == msg_id or m['sid'] == msg_id),
                None,
            )
            if record:
                self._json(200, record)
            else:
                self._json(404, {'error': f'Message {msg_id} not found'})

        elif path == '/sms/config':
            # Returns safe info only — never exposes secrets
            self._json(200, {
                'mock_mode':          MOCK_MODE,
                'twilio_configured':  bool(ACCOUNT_SID and AUTH_TOKEN and TWILIO_PHONE),
                'twilio_phone':       TWILIO_PHONE[-4:].rjust(len(TWILIO_PHONE), '*') if TWILIO_PHONE else '(not set)',
                'google_review_link': GOOGLE_REVIEW_LINK,
            })

        else:
            self._json(404, {'error': 'Not found'})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip('/')

        if path == '/sms/send':
            try:
                data          = self._read_body()
                to_phone      = data.get('to_phone', '').strip()
                body          = data.get('body', '').strip()
                job_id        = data.get('job_id', 'unknown')
                template_key  = data.get('template_key', 'unknown')
                customer_name = data.get('customer_name', 'Customer')
                sms_type      = data.get('type', 'status_update')

                if not to_phone:
                    self._json(400, {'error': 'to_phone is required'})
                    return
                if not body:
                    self._json(400, {'error': 'body is required'})
                    return
                if len(body) > 1600:
                    self._json(400, {'error': f'body too long: {len(body)} chars (max 1600)'})
                    return

                send_fn = mock_send if MOCK_MODE else live_send
                record  = send_fn(to_phone, body, job_id, template_key,
                                  customer_name, sms_type)

                self._json(200, {'success': True, 'message': record})

            except RuntimeError as e:
                log.error(f'Config error: {e}')
                self._json(500, {'error': str(e), 'success': False})
            except Exception as e:
                log.error(f'Send error: {e}')
                self._json(500, {'error': str(e), 'success': False})

        else:
            self._json(404, {'error': 'Not found'})

    def log_message(self, fmt, *args):
        pass  # suppress default access log; using our structured logger


# ─── Entry Point ──────────────────────────────────────────────────────────────
if __name__ == '__main__':
    mode_label = '🟡 MOCK MODE' if MOCK_MODE else '🟢 LIVE TWILIO'
    log.info(f'TradeRep Pro SMS API — {mode_label}')
    log.info(f'Listening on 0.0.0.0:{PORT}')
    if not MOCK_MODE:
        log.info(f'Twilio from: {TWILIO_PHONE}')

    server = HTTPServer(('0.0.0.0', PORT), SmsHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('Server stopped.')
