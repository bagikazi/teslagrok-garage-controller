// ST7789 240x240 IPS test pattern for ESP32-S3 DevKit.
// Wiring: SCL=GPIO12, SDA=GPIO11, RES=GPIO14, DC=GPIO13, CS=none, BLK=3.3V.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>

#define TFT_SCLK 12
#define TFT_MOSI 11
#define TFT_DC   13
#define TFT_RST  14
#define TFT_CS   -1  // panel has no CS pin

SPIClass lcdSPI(FSPI);
Adafruit_ST7789 tft(&lcdSPI, TFT_CS, TFT_DC, TFT_RST);

static void drawTestPattern() {
  const uint16_t bars[] = {ST77XX_WHITE, ST77XX_YELLOW, ST77XX_CYAN, ST77XX_GREEN,
                           ST77XX_MAGENTA, ST77XX_RED, ST77XX_BLUE, ST77XX_BLACK};
  const int barW = 240 / 8;
  for (int i = 0; i < 8; i++) tft.fillRect(i * barW, 0, barW, 120, bars[i]);

  // Grayscale ramp
  for (int x = 0; x < 240; x++) {
    uint8_t v = x * 255 / 239;
    tft.drawFastVLine(x, 120, 30, tft.color565(v, v, v));
  }

  tft.fillRect(0, 150, 240, 90, ST77XX_BLACK);
  tft.drawRect(0, 0, 240, 240, ST77XX_RED);  // edge check: all 4 borders must be visible
  tft.drawCircle(120, 195, 40, ST77XX_GREEN);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(40, 160);
  tft.print("ST7789 OK");
  tft.setTextSize(1);
  tft.setCursor(78, 192);
  tft.print("240x240 ESP32-S3");
}

void setup() {
  Serial.begin(115200);
  lcdSPI.begin(TFT_SCLK, -1, TFT_MOSI, -1);
  tft.init(240, 240, SPI_MODE3);  // CS-less ST7789 modules need SPI mode 3
  tft.setSPISpeed(40000000);
  tft.setRotation(2);  // 180 deg: panel is mounted upside down
  drawTestPattern();
  Serial.println("ST7789 test pattern drawn");
}

void loop() {
  static uint32_t last = 0;
  static uint16_t n = 0;
  if (millis() - last > 1000) {
    last = millis();
    tft.fillRect(90, 215, 60, 10, ST77XX_BLACK);
    tft.setCursor(100, 216);
    tft.setTextColor(ST77XX_YELLOW);
    tft.print(n++);
  }
}
