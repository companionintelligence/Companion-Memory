# Update package index
sudo apt-get update -y

# Install PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib

# Initialize the database (only needed in some environments)
sudo pg_ctlcluster $(ls /etc/postgresql) main start

# Set environment variables
DB_USER="companion_intel"
DB_PASSWORD="comp4nion_1ntel_ftw!"
DB_NAME="companion_intel"
PORT="5432"

# Wait for PostgreSQL to be fully up
sleep 2

# Create the PostgreSQL user and database
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

sudo -u postgres psql -c "ALTER USER $DB_USER WITH SUPERUSER;"

# Modify configs to allow remote access and password authentication
PG_HBA="/etc/postgresql/$(ls /etc/postgresql)/main/pg_hba.conf"
POSTGRESQL_CONF="/etc/postgresql/$(ls /etc/postgresql)/main/postgresql.conf"

sudo sed -i "s/^local\s\+all\s\+postgres\s\+peer/local all postgres md5/" "$PG_HBA"
sudo sed -i "s/^local\s\+all\s\+all\s\+peer/local all all md5/" "$PG_HBA"
sudo sed -i "s/^host\s\+all\s\+all\s\+127.0.0.1\/32\s\+ident/host all all 0.0.0.0\/0 md5/" "$PG_HBA"

sudo sed -i "s/^#listen_addresses = 'localhost'/listen_addresses = '*'/" "$POSTGRESQL_CONF"
sudo sed -i "s/^port = .*/port = $PORT/" "$POSTGRESQL_CONF"

# Restart PostgreSQL using pg_ctlcluster
sudo pg_ctlcluster $(ls /etc/postgresql) main restart

# Output summary
echo "✅ PostgreSQL setup complete:"
echo "  User:     $DB_USER"
echo "  Password: $DB_PASSWORD"
echo "  Database: $DB_NAME"
echo "  Port:     $PORT"

# Yarn
npm install -g corepack
yarn install

sudo sh -c 'echo "127.0.0.1 dev.companionintelligence.com" >> /etc/hosts'
grep dev.companionintelligence.com /etc/hosts

yarn migrate ./backend/app/api

ls -al
npm install -g pm2

pm2 start yarn --name web --cwd ./frontend/apps/web -- dev
pm2 start yarn --name api --cwd ./backend/apps/api -- dev

pm2 logs
