FROM python:3.11-slim

WORKDIR /app

# Install dependencies, Xvfb, X11 libs, and Google Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    curl \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    # Xvfb and X11 dependencies for virtual display
    xvfb \
    x11-utils \
    x11-xserver-utils \
    dbus-x11 \
    libx11-xcb1 \
    libxcb1 \
    libxext6 \
    libxrender1 \
    libxi6 \
    libxtst6 \
    # Python Tkinter for pyautogui and scrot for screenshots
    python3-tk \
    scrot \
    # Chromium for multi-arch support (AMD64 + ARM64)
    chromium \
    chromium-driver \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the UC ChromeDriver during build (instead of first API call)
RUN python -c "from seleniumbase import SB; SB(uc=True, headless=True).__enter__()" || true

COPY *.py ./
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV PYTHONUNBUFFERED=1
# Configure display for Xvfb
ENV DISPLAY=:99
ENV DBUS_SESSION_BUS_ADDRESS=/dev/null

EXPOSE 5002

# Use entrypoint script to start Xvfb before the app
ENTRYPOINT ["./entrypoint.sh"]
CMD ["python", "main.py"]
