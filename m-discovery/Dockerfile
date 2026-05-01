# Use an official Python runtime as a parent image
FROM python:3.9-slim-bullseye

# Set the working directory in the container
WORKDIR /app

# Install any needed packages specified in requirements.txt
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install postgresql-client for pg_isready
RUN apt-get update && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on (if any, though this is a CLI)
# EXPOSE 8000 

# Define environment variables for the database connection
# These will be overridden by docker-compose.yml
ENV DB_USER=user
ENV DB_PASSWORD=password
ENV DB_HOST=db
ENV DB_PORT=5432
ENV DB_NAME=music_discovery

# Command to run the application (e.g., for initial table creation or running main.py)
# This can be overridden in docker-compose.yml
CMD ["python", "src/main.py"]
