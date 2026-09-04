require('dotenv').config();
const express = require('express');
const app = express();
const path = require("path");

const http = require("http");

const socketio = require("socket.io");
const server = http.createServer(app);
const io = socketio(server);

app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory data store for trips
const trips = {};

io.on("connection", function(socket){
    // When a user creates a new trip
    socket.on("create-trip", async function (data) {
        const { tripName, destination, emails, creatorName, appUrl } = data;
        const tripId = Math.random().toString(36).substring(2, 9).toUpperCase();
        
        const invitedList = (emails || []).map(e => e.trim()).filter(e => e.length > 0);

        trips[tripId] = {
            id: tripId,
            name: tripName,
            destination: destination, // { lat, lng, address }
            emails: invitedList,
            members: {},
            messages: []
        };
        
        socket.emit("trip-created", { tripId, tripName, invitesSentCount: invitedList.length });

        // Dispatch real email invitations asynchronously
        const originUrl = appUrl || "http://localhost:3000";
        const senderName = creatorName || socket.memberName || "A fellow rider";
        
        for (const targetEmail of invitedList) {
            sendTripInviteEmail({
                toEmail: targetEmail,
                creatorName: senderName,
                tripName: tripName,
                tripId: tripId,
                destinationAddress: destination ? destination.address : "",
                appUrl: originUrl
            });
        }
    });

    // When a user invites more members to an active trip
    socket.on("invite-members", async function (data) {
        const { tripId, emails, appUrl } = data;
        if (!tripId || !trips[tripId]) {
            socket.emit("trip-error", "Trip not found.");
            return;
        }

        const newEmails = (emails || []).map(e => e.trim()).filter(e => e.length > 0 && !trips[tripId].emails.includes(e));
        trips[tripId].emails.push(...newEmails);

        const originUrl = appUrl || "http://localhost:3000";
        const senderName = socket.memberName || "Trip Rider";

        for (const targetEmail of newEmails) {
            sendTripInviteEmail({
                toEmail: targetEmail,
                creatorName: senderName,
                tripName: trips[tripId].name,
                tripId: tripId,
                destinationAddress: trips[tripId].destination ? trips[tripId].destination.address : "",
                appUrl: originUrl
            });
        }

        io.to(tripId).emit("members-invited", {
            tripId,
            newInvitesCount: newEmails.length,
            invitedBy: senderName
        });
    });

    // When a user joins an existing trip
    socket.on("join-trip", function (data) {
        const { tripId, name, email, phone, location } = data;
        
        if (!trips[tripId]) {
            socket.emit("trip-error", "Trip not found. Please check the ID or create a new trip.");
            return;
        }
        
        socket.tripId = tripId;
        socket.memberName = name;
        socket.join(tripId);
        
        trips[tripId].members[socket.id] = {
            id: socket.id,
            name: name,
            email: email,
            phone: phone || "",
            latitude: location ? location.latitude : null,
            longitude: location ? location.longitude : null,
            status: "normal" // 'normal', 'fuel', 'toilet', 'bike'
        };
        
        // Broadcast update to all members of the trip
        io.to(tripId).emit("trip-updated", trips[tripId]);
        
        // Notify others that a member joined
        socket.to(tripId).emit("member-joined", { name });
    });

    // When a user updates their live geolocation
    socket.on("send-location", function (data) {
        const { latitude, longitude } = data;
        
        if (socket.tripId && trips[socket.tripId] && trips[socket.tripId].members[socket.id]) {
            trips[socket.tripId].members[socket.id].latitude = latitude;
            trips[socket.tripId].members[socket.id].longitude = longitude;
            io.to(socket.tripId).emit("trip-updated", trips[socket.tripId]);
        } else {
            // General broadcast fallback if not in a trip
            io.emit("recieve-location", { id: socket.id, ...data });
        }
    });

    // When a user changes their riding status (e.g. fuel, toilet, issue)
    socket.on("update-status", function (data) {
        const { status } = data; // 'normal', 'fuel', 'toilet', 'bike'
        const tripId = socket.tripId;
        
        if (tripId && trips[tripId] && trips[tripId].members[socket.id]) {
            trips[tripId].members[socket.id].status = status;
            
            // Broadcast the popup message (toast) to all other trip members
            socket.to(tripId).emit("status-alert", {
                name: socket.memberName,
                status: status,
                latitude: trips[tripId].members[socket.id].latitude,
                longitude: trips[tripId].members[socket.id].longitude
            });
            
            // Emit updated trip data
            io.to(tripId).emit("trip-updated", trips[tripId]);
        }
    });

    // When a user sends a message in the group chat
    socket.on("send-chat-msg", function (data) {
        const { text } = data;
        const tripId = socket.tripId;
        
        if (tripId && trips[tripId]) {
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const message = {
                sender: socket.memberName || "Rider",
                text: text,
                time: time,
                socketId: socket.id
            };
            trips[tripId].messages.push(message);
            
            io.to(tripId).emit("chat-msg-received", message);
        }
    });

    // When a socket disconnects
    socket.on("disconnect", function(){
        const tripId = socket.tripId;
        if (tripId && trips[tripId]) {
            const memberName = socket.memberName;
            delete trips[tripId].members[socket.id];
            
            // Notify others
            socket.to(tripId).emit("member-left", { name: memberName });
            
            // Clean up empty trips
            if (Object.keys(trips[tripId].members).length === 0) {
                delete trips[tripId];
            } else {
                io.to(tripId).emit("trip-updated", trips[tripId]);
            }
        } else {
            io.emit("user-disconnected", socket.id);
        }
    });
});
    
const nodemailer = require("nodemailer");

// In-memory authentication codes store
const verificationCodes = {};

// Transporter caching for Ethereal test accounts fallback
let cachedTransporter = null;

async function getEmailTransporter() {
    // 1. Check for real production/custom SMTP credentials (e.g. Gmail App Password)
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        const cleanUser = process.env.EMAIL_USER.trim();
        const cleanPass = process.env.EMAIL_PASS.replace(/\s+/g, "");
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT || "465"),
            secure: true, // SSL for port 465
            auth: {
                user: cleanUser,
                pass: cleanPass
            },
            tls: {
                rejectUnauthorized: false
            }
        });
    }

    // 2. Fallback to Ethereal real test inbox if no custom credentials are setup
    if (!cachedTransporter) {
        try {
            const testAccount = await nodemailer.createTestAccount();
            console.log(`[NODEMAILER ETHEREAL INITIALIZED] Test Email Account: ${testAccount.user}`);
            cachedTransporter = nodemailer.createTransport({
                host: "smtp.ethereal.email",
                port: 587,
                secure: false,
                auth: {
                    user: testAccount.user,
                    pass: testAccount.pass
                }
            });
        } catch (err) {
            console.error("[NODEMAILER TEST ACCOUNT ERROR]", err);
            return null;
        }
    }
    return cachedTransporter;
}

// Function to dispatch styled HTML OTP Email
async function sendOTPEmail(toEmail, code, userName) {
    try {
        const transporter = await getEmailTransporter();
        if (!transporter) return { success: false, error: "Transporter unavailable" };

        const htmlContent = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #0f172a; border-radius: 12px; color: #f8fafc; border: 1px solid #1e293b;">
            <div style="text-align: center; margin-bottom: 24px;">
                <h1 style="color: #6366f1; margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">🏍️ RiderSync</h1>
                <p style="color: #94a3b8; font-size: 13px; margin-top: 4px;">Roadtrip Coordinate Sharing Portal</p>
            </div>
            <div style="background: rgba(30, 41, 59, 0.8); padding: 20px; border-radius: 8px; border: 1px solid #334155;">
                <h3 style="margin-top: 0; color: #f8fafc;">Hello ${userName},</h3>
                <p style="color: #cbd5e1; font-size: 14px; line-height: 1.5;">Your 6-digit email verification OTP code for RiderSync is:</p>
                <div style="text-align: center; margin: 24px 0;">
                    <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #6366f1; background: #1e1b4b; padding: 12px 28px; border-radius: 8px; border: 1.5px dashed #6366f1; display: inline-block;">${code}</span>
                </div>
                <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">⏱️ This OTP code is valid for <strong>5 minutes</strong>. If you did not request this, please ignore this email.</p>
            </div>
            <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #64748b;">
                &copy; RiderSync Real-Time Geolocation Tracking. Safe Riding!
            </div>
        </div>
        `;

        const fromAddress = process.env.EMAIL_USER ? `"RiderSync Security" <${process.env.EMAIL_USER}>` : '"RiderSync Auth" <no-reply@ridersync.com>';

        const info = await transporter.sendMail({
            from: fromAddress,
            to: toEmail,
            subject: `${code} is your RiderSync Verification Code`,
            html: htmlContent
        });

        const testPreviewUrl = nodemailer.getTestMessageUrl(info);
        if (testPreviewUrl) {
            console.log(`[EMAIL DISPATCHED TO ETHEREAL INBOX] View email here: ${testPreviewUrl}`);
        } else {
            console.log(`[REAL EMAIL DISPATCHED] OTP sent to inbox: ${toEmail} (MessageId: ${info.messageId})`);
        }

        return { success: true, previewUrl: testPreviewUrl || null };
    } catch (error) {
        console.error("[NODEMAILER SEND ERROR]", error);
        return { success: false, error: error.message };
    }
}

// Function to dispatch HTML Trip Invitation Email
async function sendTripInviteEmail({ toEmail, creatorName, tripName, tripId, destinationAddress, appUrl }) {
    try {
        const transporter = await getEmailTransporter();
        if (!transporter) return { success: false, error: "Transporter unavailable" };

        const joinLink = `${appUrl}/?tripId=${tripId}&inviteEmail=${encodeURIComponent(toEmail)}`;

        const htmlContent = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; background: #0f172a; border-radius: 14px; color: #f8fafc; border: 1px solid #1e293b;">
            <div style="text-align: center; margin-bottom: 24px;">
                <h1 style="color: #6366f1; margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">🏍️ RiderSync</h1>
                <p style="color: #94a3b8; font-size: 13px; margin-top: 4px;">Live Group Trip Invitation</p>
            </div>
            <div style="background: rgba(30, 41, 59, 0.8); padding: 24px; border-radius: 10px; border: 1px solid #334155;">
                <h2 style="margin-top: 0; color: #f8fafc; font-size: 20px;">You're invited to join a group trip!</h2>
                <p style="color: #cbd5e1; font-size: 15px; line-height: 1.5; margin-bottom: 16px;">
                    <strong style="color: #6366f1;">${creatorName}</strong> has invited you to share live GPS coordinates on the ride <strong>"${tripName}"</strong>.
                </p>
                <div style="background: #1e1b4b; padding: 14px; border-radius: 8px; border-left: 4px solid #6366f1; margin-bottom: 20px;">
                    <div style="font-size: 12px; color: #a5b4fc; font-weight: 600;">DESTINATION:</div>
                    <div style="font-size: 14px; color: #ffffff; margin-top: 2px;">📍 ${destinationAddress || "Selected Group Destination"}</div>
                    <div style="font-size: 12px; color: #a5b4fc; font-weight: 600; margin-top: 8px;">TRIP ID CODE:</div>
                    <div style="font-size: 16px; color: #6366f1; font-weight: 700; font-family: monospace;">${tripId}</div>
                </div>
                <div style="text-align: center; margin: 28px 0 16px 0;">
                    <a href="${joinLink}" target="_blank" style="background: linear-gradient(135deg, #6366f1, #4f46e5); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 10px 20px rgba(99, 102, 241, 0.35);">
                        👉 Click Here to Join Trip Live Map
                    </a>
                </div>
                <p style="text-align: center; color: #94a3b8; font-size: 12px;">Or open RiderSync and enter Trip ID: <strong>${tripId}</strong></p>
            </div>
            <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #64748b;">
                &copy; RiderSync Real-Time Geolocation Tracking. Safe Riding!
            </div>
        </div>
        `;

        const fromAddress = process.env.EMAIL_USER ? `"RiderSync Trips" <${process.env.EMAIL_USER}>` : '"RiderSync Invites" <no-reply@ridersync.com>';

        const info = await transporter.sendMail({
            from: fromAddress,
            to: toEmail,
            subject: `You're invited to join trip "${tripName}" on RiderSync! 🏍️`,
            html: htmlContent
        });

        const testPreviewUrl = nodemailer.getTestMessageUrl(info);
        if (testPreviewUrl) {
            console.log(`[TRIP INVITE ETHEREAL LINK] Sent to ${toEmail}: ${testPreviewUrl}`);
        } else {
            console.log(`[REAL TRIP INVITE SENT] Invitation email delivered to: ${toEmail}`);
        }

        return { success: true, previewUrl: testPreviewUrl || null };
    } catch (error) {
        console.error("[NODEMAILER TRIP INVITE ERROR]", error);
        return { success: false, error: error.message };
    }
}

// Helper function to generate a random 6-digit numeric OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send Code / Initial OTP Request route
app.post("/api/auth/send-code", async function (req, res) {
    const { email, name, mode } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, error: "Email is required." });
    }
    if (mode === "signup" && !name) {
        return res.status(400).json({ success: false, error: "Name is required for sign up." });
    }
    
    // Check resend cooldown if an existing request is active
    const existing = verificationCodes[email];
    if (existing && Date.now() < existing.resendAvailableAt) {
        const waitSecs = Math.ceil((existing.resendAvailableAt - Date.now()) / 1000);
        return res.json({ 
            success: true, 
            message: `OTP email already sent to ${email}!`,
            alreadyPending: true,
            expiresInSeconds: Math.ceil((existing.expiresAt - Date.now()) / 1000),
            cooldownSeconds: waitSecs
        });
    }

    // Determine user name (from request or fallback)
    let userName = name;
    if (!userName && existing && existing.name) {
        userName = existing.name;
    }
    if (!userName) {
        userName = email.split('@')[0];
    }
    
    // Generate dynamic 6-digit OTP
    const code = generateOTP();
    
    // Store in memory (expires in 5 minutes, resend available in 60 seconds, max 5 attempts)
    verificationCodes[email] = {
        code: code,
        name: userName,
        expiresAt: Date.now() + 5 * 60 * 1000,
        resendAvailableAt: Date.now() + 60 * 1000,
        attemptsLeft: 5
    };
    
    console.log(`[AUTH REAL-TIME OTP] Dispatching email for ${email} (${userName}) with code: ${code}`);
    
    // Dispatch real email via Nodemailer
    const emailResult = await sendOTPEmail(email, code, userName);

    if (!emailResult.success) {
        console.error(`[AUTH EMAIL ERROR] Failed to send OTP to ${email}:`, emailResult.error);
        return res.status(500).json({ 
            success: false, 
            error: `Email Delivery Failed: ${emailResult.error || "Check SMTP credentials"}`
        });
    }

    // Emit real-time OTP notification to socket clients (for dev visualization)
    io.emit("otp-generated", { email, code, previewUrl: emailResult.previewUrl });

    res.json({ 
        success: true, 
        message: `Real 6-digit OTP email sent to ${email}!`, 
        code: code,
        expiresInSeconds: 300,
        cooldownSeconds: 60,
        previewUrl: emailResult.previewUrl
    });
});

// Resend OTP route
app.post("/api/auth/resend-code", async function (req, res) {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, error: "Email is required." });
    }

    const existing = verificationCodes[email];
    if (!existing) {
        return res.status(400).json({ success: false, error: "No active verification session found. Please enter your email." });
    }

    if (Date.now() < existing.resendAvailableAt) {
        const waitSecs = Math.ceil((existing.resendAvailableAt - Date.now()) / 1000);
        return res.status(429).json({ 
            success: false, 
            error: `Please wait ${waitSecs} seconds before requesting a new code.`,
            cooldownSeconds: waitSecs
        });
    }

    // Generate new OTP
    const code = generateOTP();
    existing.code = code;
    existing.expiresAt = Date.now() + 5 * 60 * 1000;
    existing.resendAvailableAt = Date.now() + 60 * 1000;
    existing.attemptsLeft = 5;

    console.log(`[AUTH REAL-TIME OTP RESEND] Dispatching new OTP email for ${email} with code: ${code}`);
    
    // Dispatch real email via Nodemailer
    const emailResult = await sendOTPEmail(email, code, existing.name);

    if (!emailResult.success) {
        console.error(`[AUTH RESEND EMAIL ERROR] Failed to resend OTP to ${email}:`, emailResult.error);
        return res.status(500).json({ 
            success: false, 
            error: `Email Delivery Failed: ${emailResult.error || "Check SMTP credentials"}`
        });
    }

    io.emit("otp-generated", { email, code, previewUrl: emailResult.previewUrl });

    res.json({ 
        success: true, 
        message: `New 6-digit OTP email sent to ${email}!`, 
        code: code,
        expiresInSeconds: 300,
        cooldownSeconds: 60,
        previewUrl: emailResult.previewUrl
    });
});

// Verify Code route
app.post("/api/auth/verify-code", function (req, res) {
    const { email, code } = req.body;
    if (!email || !code) {
        return res.status(400).json({ success: false, error: "Email and code are required." });
    }
    
    const record = verificationCodes[email];
    if (!record) {
        return res.status(400).json({ success: false, error: "No verification code requested for this email." });
    }
    
    if (Date.now() > record.expiresAt) {
        delete verificationCodes[email];
        return res.status(400).json({ success: false, error: "Verification code has expired. Please request a new one." });
    }

    if (record.attemptsLeft <= 0) {
        delete verificationCodes[email];
        return res.status(400).json({ success: false, error: "Too many incorrect attempts. Code invalidated, please request a new OTP." });
    }
    
    if (record.code !== code) {
        record.attemptsLeft -= 1;
        if (record.attemptsLeft <= 0) {
            delete verificationCodes[email];
            return res.status(400).json({ success: false, error: "Incorrect OTP. Maximum attempts reached, please request a new code." });
        }
        return res.status(400).json({ 
            success: false, 
            error: `Incorrect verification code. ${record.attemptsLeft} attempt(s) remaining.` 
        });
    }
    
    const user = {
        email: email,
        name: record.name
    };
    
    // Cleanup code
    delete verificationCodes[email];
    
    res.json({ success: true, user: user });
});

app.get("/", function(req, res){
    res.render("index");
});

server.listen(3000);

