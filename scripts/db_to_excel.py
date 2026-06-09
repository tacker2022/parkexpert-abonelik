import os
import sys
import pandas as pd
from sqlalchemy import create_engine

def export_db_to_excel(db_url, output_filename):
    try:
        print("Connecting to Supabase database...")
        # SQLAlchemy engine
        engine = create_engine(db_url)
        
        tables = {
            'applications': 'Başvurular',
            'otoparks': 'Otoparklar',
            'admin_users': 'Yöneticiler',
            'system_settings': 'Sistem Ayarları',
            'audit_logs': 'Denetim Günlükleri',
            'sms_logs': 'SMS Raporları'
        }
        
        print(f"Creating Excel workbook: {output_filename}")
        with pd.ExcelWriter(output_filename, engine='openpyxl') as writer:
            for table_name, sheet_name in tables.items():
                try:
                    print(f"Fetching table '{table_name}'...")
                    # Read table into DataFrame
                    df = pd.read_sql_table(table_name, con=engine)
                    
                    # Mask passwords in admin_users for safety
                    if table_name == 'admin_users' and 'password' in df.columns:
                        df['password'] = '********'
                    
                    # Write to Excel sheet
                    df.to_excel(writer, sheet_name=sheet_name, index=False)
                    print(f"Successfully wrote {len(df)} rows to sheet '{sheet_name}'")
                except Exception as e:
                    print(f"Warning: Could not export table '{table_name}': {e}")
                    
        print("Excel backup completed successfully!")
        return True
    except Exception as e:
        print(f"Error exporting database to Excel: {e}")
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python db_to_excel.py <db_url> <output_filename>")
        sys.exit(1)
        
    db_url = sys.argv[1]
    # Handle PostgreSQL connection URL scheme compatibility for SQLAlchemy
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://")
        
    output_filename = sys.argv[2]
    export_db_to_excel(db_url, output_filename)
