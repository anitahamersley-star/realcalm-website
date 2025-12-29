const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

setGlobalOptions({ region: "australia-southeast1" });

const MAILEROO_SENDING_KEY = defineSecret("MAILEROO_SENDING_KEY");

exports.submitContactEnquiry = onRequest(
  { secrets: [MAILEROO_SENDING_KEY] },
  async (req, res) => {
    // CORS
    const origin = (req.headers && req.headers.origin) ? req.headers.origin : "";
    const allowedOrigins = new Set([
      "https://realcalm.com.au",
      "https://www.realcalm.com.au",
      "https://realcalm-website.web.app",
      "https://realcalm-website.firebaseapp.com",
      "http://localhost:5500",
      "http://localhost:5173",
      "http://localhost:5000",
    ]);

    if (allowedOrigins.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const body = req.body || {};
      const clean = (v) => String(v || "").trim();

      // Honeypot spam trap (check early)
      const website = clean(body.website);
      if (website) {
        return res.status(200).json({ ok: true });
      }

      // Validate inputs
      const firstName = clean(body.firstName);
      const lastName = clean(body.lastName);
      const email = clean(body.email).toLowerCase();
      const message = clean(body.message);

      if (!firstName || !lastName || !email || !message) {
        return res.status(400).json({ error: "Missing required fields." });
      }

      if (message.length > 5000) {
        return res.status(400).json({ error: "Message too long." });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Invalid email." });
      }

      // Metadata
      const xff = (req.headers && req.headers["x-forwarded-for"])
        ? String(req.headers["x-forwarded-for"])
        : "";
      const ipFromXff = xff ? xff.split(",")[0].trim() : "";
      const ipFromSocket = (req.socket && req.socket.remoteAddress)
        ? req.socket.remoteAddress
        : "";
      const ip = ipFromXff || ipFromSocket || "unknown";

      // Store in Firestore first (source of truth)
      const docRef = await admin.firestore().collection("contactEnquiries").add({
        firstName,
        lastName,
        email,
        message,
        status: "new",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        meta: {
          origin,
          ip,
          pageUrl: clean(body.pageUrl),
          userAgent: clean(body.userAgent),
          tz: clean(body.tz),
        },
      });

      // Send notification email via Maileroo (do not block success if it fails)
      try {
        const mailerooRes = await fetch("https://smtp.maileroo.com/api/v2/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": MAILEROO_SENDING_KEY.value(),
          },
          body: JSON.stringify({
            from: {
              address: "anita@realcalm.com.au",
              display_name: "Real Calm Website",
            },
            to: [
              {
                address: "anita@realcalm.com.au",
                display_name: "Anita Hamersley",
              },
            ],
            reply_to: {
              address: email,
              display_name: `${firstName} ${lastName}`,
            },
            subject: `New website enquiry: ${firstName} ${lastName}`,
            plain:
              `New contact form enquiry\n\n` +
              `Name: ${firstName} ${lastName}\n` +
              `Email: ${email}\n\n` +
              `Message:\n${message}\n\n` +
              `Submitted from: ${clean(body.pageUrl)}\n` +
              `Firestore ID: ${docRef.id}\n`,
            tags: {
              source: "realcalm-website",
              type: "contact-enquiry",
            },
          }),
        });

        const mailerooJson = await mailerooRes.json().catch(() => ({}));
        if (!mailerooRes.ok || mailerooJson.success === false) {
          logger.error("Maileroo send failed", {
            status: mailerooRes.status,
            mailerooJson,
          });
        }
      } catch (mailErr) {
        logger.error("Maileroo send threw error", mailErr);
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: "Internal error." });
    }
  }
);
