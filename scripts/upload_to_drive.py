import os
import sys
import json
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

def upload_file(filename, folder_id, credentials_json):
    try:
        # Load credentials from service account JSON string
        info = json.loads(credentials_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=['https://www.googleapis.com/auth/drive']
        )
        
        service = build('drive', 'v3', credentials=creds)
        
        file_metadata = {
            'name': os.path.basename(filename),
            'parents': [folder_id] if folder_id else []
        }
        
        media = MediaFileUpload(
            filename,
            mimetype='application/octet-stream',
            resumable=True
        )
        
        print(f"Uploading {filename} to Google Drive...")
        file = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id',
            supportsAllDrives=True
        ).execute()
        
        print(f"Successfully uploaded backup to Google Drive! File ID: {file.get('id')}")
        return True
    except Exception as e:
        print(f"Error uploading to Google Drive: {e}")
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python upload_to_drive.py <filename> <folder_id>")
        sys.exit(1)
        
    filename = sys.argv[1]
    folder_id = sys.argv[2]
    credentials_json = os.environ.get('GOOGLE_DRIVE_CREDENTIALS')
    
    if not credentials_json:
        print("Error: GOOGLE_DRIVE_CREDENTIALS environment variable not set.")
        sys.exit(1)
        
    upload_file(filename, folder_id, credentials_json)
