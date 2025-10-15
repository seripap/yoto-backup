import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

const DOWNLOAD_TIMEOUT_SECONDS = 120000; // 120 seconds in milliseconds

class YotoExtractor {
  constructor(url, folderName) {
    this.url = this.ensureHttps(url);
    this.folderName = folderName;
    this.baseDir = path.join(process.cwd(), folderName);
  }

  ensureHttps(url) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return "https://" + url;
    }
    return url;
  }

  cleanFilename(filename) {
    try {
      // Remove tabs and invalid characters
      let clean = filename.replace(/[\t]/g, "");
      clean = clean.replace(/[<>:"/\\|?*]/g, "").trim();
      return clean;
    } catch (error) {
      console.error("Error cleaning filename:", error);
      return "untitled";
    }
  }

  convertSeconds(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  convertBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let num = bytes;
    let unitIndex = 0;

    while (Math.abs(num) >= 1024 && unitIndex < units.length - 1) {
      num /= 1024;
      unitIndex++;
    }

    return `${num.toFixed(1)} ${units[unitIndex]}`;
  }

  getExtensionFromContentType(contentType) {
    const typeMap = {
      "audio/mpeg": "mp3",
      "audio/aac": "aac",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
      "audio/flac": "flac",
      "audio/x-m4a": "m4a",
    };

    if (contentType && typeMap[contentType]) {
      return typeMap[contentType];
    }

    throw new Error(`Unknown content type: ${contentType}`);
  }

  async fetchUrl(url, responseType = "text") {
    try {
      const response = await axios.get(url, {
        timeout: DOWNLOAD_TIMEOUT_SECONDS,
        responseType: responseType,
        maxRedirects: 5,
      });
      return response;
    } catch (error) {
      console.error(`Error fetching URL ${url}:`, error.message);
      throw error;
    }
  }

  async extractJsonData() {
    console.log("Fetching URL:", this.url);
    const response = await this.fetchUrl(this.url);

    if (response.status !== 200) {
      throw new Error(`Failed to fetch URL. Status: ${response.status}`);
    }

    // Check if response is already JSON
    if (typeof response.data === "object") {
      console.log("Detected direct JSON response");
      return response.data;
    }

    // Try to parse as JSON first
    if (typeof response.data === "string") {
      try {
        const jsonData = JSON.parse(response.data);
        console.log("Detected direct JSON response (parsed from string)");
        return jsonData;
      } catch (e) {
        // Not JSON, continue to HTML parsing
      }
    }

    // Parse as HTML and extract embedded JSON
    console.log("Parsing HTML for embedded JSON");
    const $ = cheerio.load(response.data);
    const scriptTag = $('#__NEXT_DATA__[type="application/json"]');

    if (!scriptTag.length) {
      throw new Error('No script found with ID "__NEXT_DATA__"');
    }

    const jsonData = JSON.parse(scriptTag.html());
    return jsonData;
  }

  async setupDirectories() {
    console.log("Setting up directories...");
    await fs.ensureDir(this.baseDir);
    await fs.ensureDir(path.join(this.baseDir, "tracks"));
    await fs.ensureDir(path.join(this.baseDir, "icons"));
  }

  async downloadFile(url, filepath) {
    try {
      const response = await this.fetchUrl(url, "arraybuffer");
      await fs.writeFile(filepath, response.data);
      return response;
    } catch (error) {
      console.error(`Error downloading file from ${url}:`, error.message);
      throw error;
    }
  }

  async processCard(jsonData) {
    try {
      // Handle both embedded JSON (props.pageProps.card) and direct JSON responses
      let card;
      if (
        jsonData.props &&
        jsonData.props.pageProps &&
        jsonData.props.pageProps.card
      ) {
        // HTML embedded JSON format
        card = jsonData.props.pageProps.card;
      } else if (jsonData.card) {
        // Direct JSON with card property
        card = jsonData.card;
      } else if (jsonData.cardId || jsonData.title) {
        // Direct JSON response - the data itself is the card
        card = jsonData;
      } else {
        throw new Error("Unable to find card data in JSON response");
      }

      const title = this.cleanFilename(card.title || "Untitled");
      console.log("Processing card:", title);

      await this.setupDirectories();

      // Download cover artwork
      await this.downloadArtwork(card);

      // Generate metadata files
      await this.generateMetadata(card);

      // Process tracks
      await this.processTracks(card);

      console.log("\nExtraction complete!");
      console.log(`Files saved to: ${this.baseDir}`);
    } catch (error) {
      console.error("Error processing card:", error.message);
      throw error;
    }
  }

  async downloadArtwork(card) {
    try {
      console.log("Downloading artwork...");
      const coverImageUrl = card.metadata?.cover?.imageL;

      if (coverImageUrl) {
        const artworkPath = path.join(this.baseDir, "artwork.png");
        await this.downloadFile(coverImageUrl, artworkPath);
        console.log("Artwork downloaded");
      } else {
        console.log("No artwork found");
      }
    } catch (error) {
      console.error("Error downloading artwork:", error.message);
    }
  }

  async generateMetadata(card) {
    console.log("Generating metadata...");
    const metaundef = "__undefined__";
    let metadata = "YOTO Card Metadata\n";
    metadata += "===================\n\n";

    // Basic Details
    metadata += "Basic Details\n";
    metadata += "-------------\n";
    metadata += `Title: ${card.title || metaundef}\n`;
    metadata += `Author: ${card.metadata?.author || "MYO"}\n`;
    metadata += `Description: ${card.metadata?.description || metaundef}\n\n`;

    // Extended Details
    metadata += "Extended Details\n";
    metadata += "----------------\n";
    metadata += `Version: ${card.content?.version || metaundef}\n`;
    metadata += `Category: ${card.metadata?.category || metaundef}\n`;

    if (card.metadata?.languages) {
      metadata += `Languages: ${card.metadata.languages.join(", ")}\n`;
    }

    metadata += `Playback Type: ${card.content?.playbackType || metaundef}\n`;
    metadata += `Card ID: ${card.cardId || metaundef}\n`;
    metadata += `Created At: ${card.createdAt || metaundef}\n`;
    metadata += `Updated At: ${card.updatedAt || metaundef}\n`;
    metadata += `Slug: ${card.slug || metaundef}\n`;

    const duration = card.metadata?.media?.duration;
    if (duration) {
      metadata += `Duration (seconds): ${duration}\n`;
      metadata += `Duration (readable): ${this.convertSeconds(duration)}\n`;
    }

    const fileSize = card.metadata?.media?.fileSize;
    if (fileSize) {
      metadata += `File Size (bytes): ${fileSize}\n`;
      metadata += `File Size (readable): ${this.convertBytes(fileSize)}\n`;
    }

    metadata += "\n";

    // Share Statistics
    metadata += "Share Statistics\n";
    metadata += "----------------\n";
    metadata += `Share Count: ${card.shareCount || metaundef}\n`;
    metadata += `Availability: ${card.content?.availability || metaundef}\n`;
    metadata += `Share Link URL: ${card.shareLinkUrl || metaundef}\n`;

    const metadataPath = path.join(this.baseDir, "metadata.txt");
    await fs.writeFile(metadataPath, metadata);
    console.log("Metadata file created");
  }

  async processTracks(card) {
    console.log("Processing tracks...");
    const chapters = card.content?.chapters || [];

    let trackCounter = 0;

    // Count total tracks for padding
    for (const chapter of chapters) {
      trackCounter += chapter.tracks?.length || 0;
    }

    const padLength = trackCounter.toString().length;
    console.log(`Found ${trackCounter} tracks`);

    trackCounter = 0;
    let trackDetailsContent = "Track Details\n=============\n\n";

    for (const chapter of chapters) {
      const tracks = chapter.tracks || [];

      for (const track of tracks) {
        trackCounter++;
        const trackNum = trackCounter.toString().padStart(padLength, "0");

        console.log(`Processing track ${trackNum}/${trackCounter}...`);

        const trackTitle = track.title || "Untitled";
        const audioUrl = track.trackUrl;

        // Download audio file
        let audioExt = "mp3";
        let iconFilename = "";

        if (audioUrl) {
          try {
            const response = await this.downloadFile(
              audioUrl,
              path.join(this.baseDir, "tracks", "temp"),
            );

            const contentType = response.headers["content-type"];
            audioExt = this.getExtensionFromContentType(contentType);

            const audioFilename = this.cleanFilename(
              `${trackNum} - ${trackTitle}.${audioExt}`,
            );
            const audioPath = path.join(this.baseDir, "tracks", audioFilename);

            await fs.move(
              path.join(this.baseDir, "tracks", "temp"),
              audioPath,
              { overwrite: true },
            );
          } catch (error) {
            console.error(
              `Error downloading track ${trackNum}:`,
              error.message,
            );
          }
        }

        // Download icon
        const trackDisplay = track.display;
        const chapterDisplay = chapter.display;
        const iconUrl = trackDisplay?.icon16x16 || chapterDisplay?.icon16x16;

        if (iconUrl) {
          try {
            iconFilename = `${trackNum}.png`;
            const iconPath = path.join(this.baseDir, "icons", iconFilename);
            await this.downloadFile(iconUrl, iconPath);
          } catch (error) {
            console.error(
              `Error downloading icon for track ${trackNum}:`,
              error.message,
            );
          }
        }

        // Add to track details
        trackDetailsContent += `Track Number: ${trackNum}\n`;
        trackDetailsContent += `Title: ${trackTitle}\n`;
        trackDetailsContent += `Type: ${track.type || "__undefined__"}\n`;

        if (track.duration) {
          trackDetailsContent += `Duration (seconds): ${track.duration}\n`;
          trackDetailsContent += `Duration (readable): ${this.convertSeconds(track.duration)}\n`;
        }

        if (track.fileSize) {
          trackDetailsContent += `File Size (bytes): ${track.fileSize}\n`;
          trackDetailsContent += `File Size (readable): ${this.convertBytes(track.fileSize)}\n`;
        }

        trackDetailsContent += `Channels: ${track.channels || "__undefined__"}\n`;
        trackDetailsContent += `Format: ${track.format || "__undefined__"}\n`;
        trackDetailsContent += "\n";
      }
    }

    // Write track details
    await fs.writeFile(
      path.join(this.baseDir, "track-details.txt"),
      trackDetailsContent,
    );

    console.log("All tracks processed");
  }

  async extract() {
    try {
      const jsonData = await this.extractJsonData();
      await this.processCard(jsonData);
    } catch (error) {
      console.error("Extraction failed:", error.message);
      process.exit(1);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: node yoto.js <url> <folder-name>");
    console.log("");
    console.log("Example:");
    console.log("  node yoto.js https://yoto.io/abc?12=345 folder-name");
    process.exit(1);
  }

  const [url, folderName] = args;

  const extractor = new YotoExtractor(url, folderName);
  await extractor.extract();
}

main();
