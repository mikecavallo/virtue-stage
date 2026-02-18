#!/usr/bin/env python3
"""
Virtual Staging API Server
Bridges the React frontend with the staging engine.
"""

import os
import sys
import json
import uuid
import time
import hashlib
import hmac
import base64
import threading
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Load .env file
env_path = Path(__file__).parent / '.env'
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, val = line.split('=', 1)
            os.environ.setdefault(key.strip(), val.strip())

# Add engine to path
sys.path.insert(0, os.path.dirname(__file__))
from virtual_stager import VirtualStager, OpenAIStagingModel, GeminiStagingModel, STYLES

# Storage
JOBS = {}
UPLOAD_DIR = Path(__file__).parent / "uploads"
OUTPUT_DIR = Path(__file__).parent / "output"
USERS_FILE = Path(__file__).parent / "users.json"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

SECRET = os.getenv('JWT_SECRET', 'virtuestage-dev-secret-change-me')


# ─── Simple Auth Helpers ───

def load_users():
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text())
    return {}

def save_users(users):
    USERS_FILE.write_text(json.dumps(users, indent=2))

def hash_password(password):
    salt = os.urandom(16).hex()
    h = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex()
    return f"{salt}:{h}"

def verify_password(password, stored):
    salt, h = stored.split(':')
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex() == h

def make_token(user_id):
    payload = json.dumps({'uid': user_id, 'exp': int(time.time()) + 86400 * 7})
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    sig = hmac.new(SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"

def verify_token(token):
    try:
        payload_b64, sig = token.split('.')
        expected = hmac.new(SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        if payload.get('exp', 0) < time.time():
            return None
        return payload['uid']
    except Exception:
        return None

def get_user_from_request(handler):
    auth = handler.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        return verify_token(auth[7:])
    return None


# ─── Staging Job Runner ───

def run_staging_job(job_id, image_path, style, model='openai'):
    import shutil
    try:
        JOBS[job_id]['status'] = 'processing'
        stager = VirtualStager()

        if model in ('gemini-flash', 'gemini-pro'):
            if not os.getenv('GOOGLE_API_KEY'):
                JOBS[job_id]['status'] = 'error'
                JOBS[job_id]['error'] = 'No GOOGLE_API_KEY set'
                return
            stager.add_model(model, GeminiStagingModel(model))
        else:
            openai_key = os.getenv('OPENAI_API_KEY')
            if not openai_key:
                JOBS[job_id]['status'] = 'error'
                JOBS[job_id]['error'] = 'No OPENAI_API_KEY set'
                return
            stager.add_model('openai', OpenAIStagingModel(openai_key))
        results = stager.stage_room_all_models(str(image_path), style)
        staged_images = []
        for name, (output_path, metadata) in results.items():
            if output_path and 'error' not in metadata:
                # Copy output to OUTPUT_DIR for reliable serving
                out_basename = os.path.basename(output_path)
                dest = OUTPUT_DIR / out_basename
                if Path(output_path).exists() and not dest.exists():
                    shutil.copy2(output_path, dest)
                staged_images.append({
                    'model': name,
                    'path': output_path,
                    'url': f'/api/staging/image/{out_basename}',
                    'metadata': metadata
                })
        JOBS[job_id]['status'] = 'complete'
        JOBS[job_id]['results'] = staged_images
        JOBS[job_id]['completed_at'] = time.time()
    except Exception as e:
        JOBS[job_id]['status'] = 'error'
        JOBS[job_id]['error'] = str(e)


class StagingHandler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    def _json_response(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == '/api/health':
            self._json_response({'status': 'ok', 'engine': 'virtual-stager'})

        elif path == '/api/auth/me':
            uid = get_user_from_request(self)
            if not uid:
                return self._json_response({'error': 'Unauthorized'}, 401)
            users = load_users()
            u = users.get(uid)
            if not u:
                return self._json_response({'error': 'User not found'}, 404)
            self._json_response({'user': {'id': uid, 'email': u['email'], 'name': u.get('name', '')}})

        elif path == '/api/staging/styles':
            self._json_response({'styles': list(STYLES.keys())})

        elif path == '/api/staging/jobs':
            uid = get_user_from_request(self)
            if not uid:
                return self._json_response({'error': 'Unauthorized'}, 401)
            user_jobs = []
            for jid, job in JOBS.items():
                if job.get('user_id') == uid:
                    j = {
                        'jobId': jid,
                        'status': job['status'],
                        'style': job['style'],
                        'model': job.get('model', 'openai'),
                        'room_type': job.get('room_type', ''),
                        'created_at': job['created_at'],
                        'results': job.get('results', []),
                    }
                    # Add original image URL
                    if job.get('images'):
                        j['originalUrl'] = f'/api/staging/image/{os.path.basename(job["images"][0])}'
                    user_jobs.append(j)
            user_jobs.sort(key=lambda x: x['created_at'], reverse=True)
            self._json_response({'jobs': user_jobs})

        elif path.startswith('/api/staging/status/'):
            job_id = path.split('/')[-1]
            if job_id in JOBS:
                job = JOBS[job_id]
                self._json_response({
                    'jobId': job_id,
                    'status': job['status'],
                    'style': job['style'],
                    'created_at': job['created_at']
                })
            else:
                self._json_response({'error': 'Job not found'}, 404)

        elif path.startswith('/api/staging/results/'):
            job_id = path.split('/')[-1]
            if job_id in JOBS:
                job = JOBS[job_id]
                data = {
                    'jobId': job_id,
                    'status': job['status'],
                    'style': job['style'],
                    'model': job.get('model', 'openai'),
                    'room_type': job.get('room_type', ''),
                    'results': job.get('results', []),
                    'error': job.get('error')
                }
                if job.get('images'):
                    data['originalUrl'] = f'/api/staging/image/{os.path.basename(job["images"][0])}'
                self._json_response(data)
            else:
                self._json_response({'error': 'Job not found'}, 404)

        elif path.startswith('/api/staging/image/'):
            filename = path.split('/')[-1]
            # Search uploads, output, engine dir, and also do a glob for partial matches
            for search_dir in [UPLOAD_DIR, OUTPUT_DIR, Path(__file__).parent]:
                filepath = search_dir / filename
                if filepath.exists():
                    self.send_response(200)
                    ct = 'image/png' if filename.endswith('.png') else 'image/jpeg'
                    self.send_header('Content-Type', ct)
                    self.send_header('Cache-Control', 'public, max-age=3600')
                    self._cors()
                    self.end_headers()
                    self.wfile.write(filepath.read_bytes())
                    return
            # Try absolute path match (for results that stored full paths)
            abs_path = Path(filename)
            if not abs_path.is_absolute():
                # Search all dirs for files containing this name
                for search_dir in [UPLOAD_DIR, OUTPUT_DIR]:
                    for f in search_dir.iterdir():
                        if filename in f.name:
                            self.send_response(200)
                            ct = 'image/png' if f.name.endswith('.png') else 'image/jpeg'
                            self.send_header('Content-Type', ct)
                            self.send_header('Cache-Control', 'public, max-age=3600')
                            self._cors()
                            self.end_headers()
                            self.wfile.write(f.read_bytes())
                            return
            self._json_response({'error': 'Image not found'}, 404)

        else:
            self._json_response({'error': 'Not found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path

        # ─── Auth endpoints ───

        if path == '/api/auth/signup':
            body = self._read_json_body()
            email = body.get('email', '').strip().lower()
            password = body.get('password', '')
            name = body.get('name', '').strip()
            if not email or not password:
                return self._json_response({'error': 'Email and password required'}, 400)
            if len(password) < 6:
                return self._json_response({'error': 'Password must be at least 6 characters'}, 400)
            users = load_users()
            # Check if email exists
            for uid, u in users.items():
                if u['email'] == email:
                    return self._json_response({'error': 'Email already registered'}, 409)
            uid = str(uuid.uuid4())[:12]
            users[uid] = {
                'email': email,
                'password': hash_password(password),
                'name': name,
                'created_at': time.time()
            }
            save_users(users)
            token = make_token(uid)
            self._json_response({'token': token, 'user': {'id': uid, 'email': email, 'name': name}})

        elif path == '/api/auth/login':
            body = self._read_json_body()
            email = body.get('email', '').strip().lower()
            password = body.get('password', '')
            users = load_users()
            for uid, u in users.items():
                if u['email'] == email:
                    if verify_password(password, u['password']):
                        token = make_token(uid)
                        return self._json_response({'token': token, 'user': {'id': uid, 'email': email, 'name': u.get('name', '')}})
                    else:
                        return self._json_response({'error': 'Invalid password'}, 401)
            self._json_response({'error': 'No account found with that email'}, 404)

        # ─── Upload endpoint ───

        elif path == '/api/staging/upload':
            uid = get_user_from_request(self)
            if not uid:
                return self._json_response({'error': 'Unauthorized'}, 401)

            content_type = self.headers.get('Content-Type', '')
            if 'multipart/form-data' not in content_type:
                return self._json_response({'error': 'Expected multipart/form-data'}, 400)

            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            boundary = None
            for part in content_type.split(';'):
                part = part.strip()
                if part.startswith('boundary='):
                    boundary = part.split('=', 1)[1].strip('"')
                    break
            if not boundary:
                return self._json_response({'error': 'No boundary in content type'}, 400)

            style = 'modern'
            model_choice = 'openai'
            room_type = 'living-room'
            job_id = str(uuid.uuid4())[:8]
            uploaded = []
            boundary_bytes = f'--{boundary}'.encode()
            parts = body.split(boundary_bytes)

            for part in parts:
                if not part or part == b'--\r\n' or part == b'--':
                    continue
                if b'\r\n\r\n' in part:
                    header_data, file_data = part.split(b'\r\n\r\n', 1)
                    if file_data.endswith(b'\r\n'):
                        file_data = file_data[:-2]
                    header_str = header_data.decode('utf-8', errors='replace')
                    name = None
                    filename_field = None
                    for line in header_str.split('\r\n'):
                        if 'name="' in line:
                            name = line.split('name="')[1].split('"')[0]
                        if 'filename="' in line:
                            filename_field = line.split('filename="')[1].split('"')[0]
                    if name == 'style':
                        style = file_data.decode().strip()
                    elif name == 'model':
                        model_choice = file_data.decode().strip()
                    elif name == 'room_type':
                        room_type = file_data.decode().strip()
                    elif name and name.startswith('room_') and filename_field:
                        ext = '.png' if 'png' in filename_field.lower() else '.jpg'
                        fname = f"{job_id}_{name}{ext}"
                        filepath = UPLOAD_DIR / fname
                        filepath.write_bytes(file_data)
                        uploaded.append(str(filepath))

            if style == 'auto':
                style = 'modern'
            if not uploaded:
                return self._json_response({'error': 'No files uploaded'}, 400)

            if model_choice not in ('openai', 'gemini-flash', 'gemini-pro'):
                model_choice = 'openai'

            JOBS[job_id] = {
                'status': 'queued',
                'style': style,
                'model': model_choice,
                'room_type': room_type,
                'images': uploaded,
                'created_at': time.time(),
                'results': [],
                'user_id': uid
            }

            for img_path in uploaded:
                t = threading.Thread(target=run_staging_job, args=(job_id, img_path, style, model_choice))
                t.daemon = True
                t.start()

            self._json_response({
                'jobId': job_id,
                'status': 'queued',
                'message': f'Processing {len(uploaded)} image(s) with {style} style'
            })

        else:
            self._json_response({'error': 'Not found'}, 404)

    def log_message(self, format, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {args[0]}")


def main():
    port = int(os.getenv('PORT', 3099))
    server = HTTPServer(('0.0.0.0', port), StagingHandler)
    print(f"🏠 Virtual Staging API running on http://localhost:{port}")
    print(f"   OpenAI key: {'✅ Set' if os.getenv('OPENAI_API_KEY') else '❌ Not set'}")
    print(f"   Upload dir: {UPLOAD_DIR}")
    print(f"   Styles: {', '.join(STYLES.keys())}")
    server.serve_forever()

if __name__ == '__main__':
    main()
