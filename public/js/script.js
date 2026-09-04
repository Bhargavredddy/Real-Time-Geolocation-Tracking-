const socket = io();

// State Variables
let myLocation = null;
let activeTrip = null;
let selectedDestination = null;
let markers = {};
let destMarker = null;
let destRouteLines = {}; // member socket.id -> Polyline
let currentStatus = "normal";

// Trip Live GPS Tracking Control & Simulation State
let isTripTrackingActive = false;
let simulateTimer = null;
let simulateStepIdx = 0;

// Authentication Flow State & Resend Timer
let authUser = null;
let authEmail = null;
let authMode = "signin"; // 'signin' or 'signup'
let countdownTimer = null;
let secondsRemaining = 60;

// Auth DOM Elements
const authScreen = document.getElementById("auth-screen");
const tabSignIn = document.getElementById("tab-signin");
const tabSignUp = document.getElementById("tab-signup");
const signinForm = document.getElementById("signin-form");
const signupForm = document.getElementById("signup-form");
const verifyForm = document.getElementById("verify-form");
const verifyTargetEmail = document.getElementById("verify-target-email");
const backToAuthBtn = document.getElementById("btn-back-to-auth");
const signoutBtn = document.getElementById("auth-signout-btn");
const otpBoxes = document.querySelectorAll(".otp-box");
const hiddenVerifyCode = document.getElementById("verify-code");
const resendOtpBtn = document.getElementById("btn-resend-otp");
const otpTimerText = document.getElementById("otp-timer-text");
const resendCountdownDisplay = document.getElementById("resend-countdown");

// Check Authentication on Page Load
function checkAuth() {
    try {
        const savedUser = localStorage.getItem("authenticatedUser");
        if (savedUser) {
            const parsed = JSON.parse(savedUser);
            if (parsed && parsed.email) {
                authUser = parsed;
                if (authScreen) authScreen.classList.add("hidden");
                
                const userNameInput = document.getElementById("user-name");
                const userEmailInput = document.getElementById("user-email");
                
                if (userNameInput) {
                    userNameInput.value = authUser.name || authUser.email.split('@')[0];
                    userNameInput.readOnly = true;
                }
                if (userEmailInput) {
                    userEmailInput.value = authUser.email;
                    userEmailInput.readOnly = true;
                }
                
                if (signoutBtn) signoutBtn.classList.remove("hidden");
                return;
            }
        }
    } catch (err) {
        console.error("Error checking auth state:", err);
        localStorage.removeItem("authenticatedUser");
    }

    // Default unauthenticated state
    authUser = null;
    if (authScreen) authScreen.classList.remove("hidden");
    if (signoutBtn) signoutBtn.classList.add("hidden");
}

// 6-Digit Segmented OTP Input Handling
if (otpBoxes.length > 0) {
    otpBoxes.forEach((box, index) => {
        // Handle input change & auto-advance
        box.addEventListener("input", (e) => {
            const val = e.target.value.replace(/[^0-9]/g, "");
            box.value = val;

            if (val) {
                box.classList.add("filled");
                if (index < otpBoxes.length - 1) {
                    otpBoxes[index + 1].focus();
                }
            } else {
                box.classList.remove("filled");
            }

            syncCombinedOtpCode();
        });

        // Handle Backspace and Arrow keys
        box.addEventListener("keydown", (e) => {
            if (e.key === "Backspace") {
                if (!box.value && index > 0) {
                    otpBoxes[index - 1].focus();
                    otpBoxes[index - 1].value = "";
                    otpBoxes[index - 1].classList.remove("filled");
                }
            } else if (e.key === "ArrowLeft" && index > 0) {
                otpBoxes[index - 1].focus();
            } else if (e.key === "ArrowRight" && index < otpBoxes.length - 1) {
                otpBoxes[index + 1].focus();
            }
        });

        // Handle Paste event for 6-digit codes
        box.addEventListener("paste", (e) => {
            e.preventDefault();
            const pasteData = (e.clipboardData || window.clipboardData).getData("text").trim();
            const digits = pasteData.replace(/[^0-9]/g, "").slice(0, 6);

            if (digits) {
                digits.split("").forEach((digit, i) => {
                    if (otpBoxes[i]) {
                        otpBoxes[i].value = digit;
                        otpBoxes[i].classList.add("filled");
                    }
                });
                const focusIdx = Math.min(digits.length, otpBoxes.length - 1);
                otpBoxes[focusIdx].focus();
                syncCombinedOtpCode();
            }
        });
    });
}

function syncCombinedOtpCode() {
    let combined = "";
    otpBoxes.forEach(box => combined += box.value);
    if (hiddenVerifyCode) hiddenVerifyCode.value = combined;
    return combined;
}

function clearOtpInputs() {
    otpBoxes.forEach(box => {
        box.value = "";
        box.classList.remove("filled", "invalid-shake");
    });
    if (hiddenVerifyCode) hiddenVerifyCode.value = "";
}

function triggerOtpShake() {
    otpBoxes.forEach(box => {
        box.classList.add("invalid-shake");
        setTimeout(() => box.classList.remove("invalid-shake"), 450);
    });
}

// Real-Time Countdown Timer for OTP Resend
function startResendCountdown(durationSeconds = 60) {
    if (countdownTimer) clearInterval(countdownTimer);

    secondsRemaining = durationSeconds;
    resendCountdownDisplay.textContent = secondsRemaining;
    otpTimerText.classList.remove("hidden");
    resendOtpBtn.classList.add("hidden");

    countdownTimer = setInterval(() => {
        secondsRemaining--;
        if (secondsRemaining > 0) {
            resendCountdownDisplay.textContent = secondsRemaining;
        } else {
            clearInterval(countdownTimer);
            otpTimerText.classList.add("hidden");
            resendOtpBtn.classList.remove("hidden");
        }
    }, 1000);
}

// Bind Authentication Form Listeners
if (tabSignIn && tabSignUp) {
    tabSignIn.addEventListener("click", () => {
        authMode = "signin";
        tabSignIn.classList.add("active");
        tabSignUp.classList.remove("active");
        signinForm.classList.add("active");
        signupForm.classList.remove("active");
        verifyForm.classList.remove("active");
    });
    
    tabSignUp.addEventListener("click", () => {
        authMode = "signup";
        tabSignUp.classList.add("active");
        tabSignIn.classList.remove("active");
        signupForm.classList.add("active");
        signinForm.classList.remove("active");
        verifyForm.classList.remove("active");
    });
}

// Handle sending code
if (signinForm) {
    signinForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const email = document.getElementById("signin-email").value.trim();
        sendCode(email, null, "signin");
    });
}

if (signupForm) {
    signupForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const name = document.getElementById("signup-name").value.trim();
        const email = document.getElementById("signup-email").value.trim();
        sendCode(email, name, "signup");
    });
}

function sendCode(email, name, mode) {
    if (!email) {
        showToast("Email Required", "Please enter your email address.", "info");
        return;
    }
    authEmail = email;

    const submitBtn = mode === "signup" ? document.getElementById("signup-submit-btn") : document.getElementById("signin-submit-btn");
    const originalText = submitBtn ? submitBtn.innerHTML : "Send Code";
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span style="font-size:13px">Sending OTP Email...</span>`;
    }

    fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, mode })
    })
    .then(res => res.json())
    .then(data => {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
            lucide.createIcons();
        }

        if (data.success) {
            // Hide signin/signup panels, show verify panel
            signinForm.classList.remove("active");
            signupForm.classList.remove("active");
            verifyForm.classList.add("active");
            verifyTargetEmail.textContent = email;
            
            clearOtpInputs();
            if (otpBoxes.length > 0) otpBoxes[0].focus();

            // Start 60-second real-time resend timer
            startResendCountdown(data.cooldownSeconds || 60);

            if (data.alreadyPending) {
                showToast("OTP Pending", `An active OTP was already sent to ${email}. Check your inbox.`, "info");
            } else {
                showToast("OTP Email Dispatched", `Sent 6-digit verification OTP to ${email}.`, "success");
            }
            
            if (data.previewUrl) {
                console.log("[EMAIL PREVIEW LINK]", data.previewUrl);
            }
        } else {
            showToast("Auth Error", data.error || "Failed to send OTP email", "bike");
        }
    })
    .catch(err => {
        console.error(err);
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
            lucide.createIcons();
        }
        showToast("Network Error", "Authentication request failed.", "bike");
    });
}

// Handle Resend OTP button click
if (resendOtpBtn) {
    resendOtpBtn.addEventListener("click", () => {
        if (!authEmail) return;

        fetch("/api/auth/resend-code", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: authEmail })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                clearOtpInputs();
                if (otpBoxes.length > 0) otpBoxes[0].focus();
                startResendCountdown(data.cooldownSeconds || 60);
                showToast("OTP Email Resent", `Sent new 6-digit code to ${authEmail}. Code: ${data.code}`, "success");
                if (data.previewUrl) {
                    console.log("[EMAIL PREVIEW LINK]", data.previewUrl);
                }
            } else {
                showToast("Resend Failed", data.error || "Could not resend email", "bike");
            }
        })
        .catch(err => {
            console.error(err);
            showToast("Network Error", "Resend request failed.", "bike");
        });
    });
}

// Handle verifying code
if (verifyForm) {
    verifyForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const code = syncCombinedOtpCode();
        
        if (code.length < 6) {
            triggerOtpShake();
            showToast("Incomplete Code", "Please enter all 6 digits of the OTP.", "info");
            return;
        }

        fetch("/api/auth/verify-code", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: authEmail, code })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                // Save user and refresh state
                localStorage.setItem("authenticatedUser", JSON.stringify(data.user));
                showToast("Access Granted", `Welcome back, ${data.user.name}!`, "success");
                
                clearOtpInputs();
                if (countdownTimer) clearInterval(countdownTimer);
                
                // Run auth reload
                checkAuth();
            } else {
                triggerOtpShake();
                showToast("Verification Failed", data.error || "Incorrect OTP code", "bike");
            }
        })
        .catch(err => {
            console.error(err);
            triggerOtpShake();
            showToast("Network Error", "Code verification failed.", "bike");
        });
    });
}

if (backToAuthBtn) {
    backToAuthBtn.addEventListener("click", () => {
        verifyForm.classList.remove("active");
        if (countdownTimer) clearInterval(countdownTimer);
        if (authMode === "signin") {
            signinForm.classList.add("active");
        } else {
            signupForm.classList.add("active");
        }
    });
}

if (signoutBtn) {
    signoutBtn.addEventListener("click", () => {
        localStorage.removeItem("authenticatedUser");
        showToast("Signed Out", "You have successfully signed out.", "info");
        window.location.reload();
    });
}

// Listen for Socket real-time OTP updates (for multi-tab / dev sync)
socket.on("otp-generated", (data) => {
    if (authEmail && data.email === authEmail) {
        console.log("[SOCKET OTP NOTIFICATION]", data);
    }
});

// Run auth check on initialization
checkAuth();

// Initialize Leaflet Map
const map = L.map("map").setView([0, 0], 3);

// OpenStreetMap tiles
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "OpenStreetMap contributors"
}).addTo(map);

// Watch Geolocation
if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            myLocation = { latitude, longitude };
            
            // If map is at default (0,0), center it on user's first location
            if (map.getCenter().lat === 0 && map.getCenter().lng === 0) {
                map.setView([latitude, longitude], 15);
            }
            
            // Send position updates to server
            socket.emit("send-location", { latitude, longitude });
        },
        (error) => {
            console.error("Error getting location: ", error);
            showToast("Location Error", "Could not fetch your live coordinates. Check browser permissions.", "bike");
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0,
        }
    );
} else {
    showToast("Not Supported", "Geolocation is not supported by your browser.", "bike");
}

// Nominatim Destination Search
const searchInput = document.getElementById("trip-destination");
const searchBtn = document.getElementById("search-dest-btn");
const searchDropdown = document.getElementById("search-results");
const destDisplay = document.getElementById("selected-destination-display");
const destDisplayText = document.getElementById("dest-display-text");

let searchDebounce = null;
let previewDestinationMarker = null;
let isProgrammaticInput = false;

searchBtn.addEventListener("click", performSearch);

searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    if (isProgrammaticInput) {
        isProgrammaticInput = false;
        searchDropdown.classList.add("hidden");
        searchDropdown.innerHTML = "";
        return;
    }
    const query = searchInput.value.trim();
    if (selectedDestination && query === selectedDestination.address) {
        searchDropdown.classList.add("hidden");
        searchDropdown.innerHTML = "";
        return;
    }
    if (query.length > 2) {
        searchDebounce = setTimeout(performSearch, 350);
    } else {
        searchDropdown.classList.add("hidden");
    }
});

searchInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(searchDebounce);
        performSearch();
    }
});

function selectDestinationItem(item) {
    clearTimeout(searchDebounce);
    isProgrammaticInput = true;

    selectedDestination = {
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        address: item.display_name
    };
    
    searchInput.value = item.display_name;
    destDisplayText.textContent = item.display_name;
    destDisplay.classList.remove("hidden");

    // Immediately clear HTML and hide search dropdown
    searchDropdown.innerHTML = "";
    searchDropdown.classList.add("hidden");
    searchDropdown.style.display = "none";

    // Drop/Update Preview Destination Marker on Map
    if (previewDestinationMarker) {
        previewDestinationMarker.setLatLng([selectedDestination.lat, selectedDestination.lng]);
    } else {
        const previewIcon = L.divIcon({
            className: "dest-marker-preview",
            html: `<div class="dest-marker-pin" style="background:#ef4444; color:white; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:18px; box-shadow:0 0 12px rgba(239,68,68,0.6);">🚩</div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 34]
        });
        previewDestinationMarker = L.marker([selectedDestination.lat, selectedDestination.lng], { icon: previewIcon }).addTo(map);
    }
    
    previewDestinationMarker.bindPopup(`<b>Selected Destination:</b><br>${item.display_name}`).openPopup();
    map.setView([selectedDestination.lat, selectedDestination.lng], 14);
    
    showToast("Destination Selected", item.display_name.split(",")[0], "success");
}

function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    searchBtn.innerHTML = `<span style="font-size:12px">...</span>`;
    fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
            searchBtn.innerHTML = `<i data-lucide="search"></i>`;
            lucide.createIcons();
            
            searchDropdown.innerHTML = "";
            if (data && data.length > 0) {
                searchDropdown.classList.remove("hidden");
                searchDropdown.style.display = "block";
                data.forEach(item => {
                    const li = document.createElement("li");
                    li.textContent = item.display_name;
                    
                    li.addEventListener("mousedown", (e) => {
                        e.preventDefault(); // Prevents input blur before click handler
                    });

                    li.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        selectDestinationItem(item);
                    });
                    
                    searchDropdown.appendChild(li);
                });
            } else {
                searchDropdown.classList.add("hidden");
                searchDropdown.style.display = "none";
                showToast("No Results", "No locations matching search query.", "info");
            }
        })
        .catch(err => {
            console.error(err);
            searchBtn.innerHTML = `<i data-lucide="search"></i>`;
            lucide.createIcons();
            searchDropdown.classList.add("hidden");
            searchDropdown.style.display = "none";
            showToast("Search Failed", "Nominatim lookup failed. Try again.", "bike");
        });
}

// Close dropdown on click outside
document.addEventListener("click", (e) => {
    if (searchInput && searchDropdown && searchBtn) {
        if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target) && !searchBtn.contains(e.target)) {
            searchDropdown.classList.add("hidden");
            searchDropdown.style.display = "none";
        }
    }
});

// Sidebar Toggle
const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const toggleIcon = document.getElementById("toggle-icon");

sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    sidebarToggle.classList.toggle("collapsed");
    
    if (sidebar.classList.contains("collapsed")) {
        toggleIcon.setAttribute("data-lucide", "chevron-right");
    } else {
        toggleIcon.setAttribute("data-lucide", "chevron-left");
    }
    lucide.createIcons();
});

// Sidebar Sections Toggle
const toggleLink = document.getElementById("toggle-section-link");
const createSection = document.getElementById("create-trip-section");
const joinSection = document.getElementById("join-trip-section");

toggleLink.addEventListener("click", () => {
    if (createSection.classList.contains("active")) {
        showJoinSection();
    } else {
        showCreateSection();
    }
});

function showJoinSection() {
    createSection.classList.remove("active");
    joinSection.classList.add("active");
    createSection.classList.add("hidden");
    joinSection.classList.remove("hidden");
    toggleLink.textContent = "Switch to Create Trip";
}

function showCreateSection() {
    joinSection.classList.remove("active");
    createSection.classList.add("active");
    joinSection.classList.add("hidden");
    createSection.classList.remove("hidden");
    toggleLink.textContent = "Switch to Join Trip";
}

// Check URL parameters for trip invitation code & invited email
window.addEventListener("DOMContentLoaded", () => {
    const urlParams = new URLSearchParams(window.location.search);
    const tripId = urlParams.get("tripId");
    const inviteEmail = urlParams.get("inviteEmail");

    if (tripId) {
        document.getElementById("join-trip-id").value = tripId;
        if (inviteEmail) {
            document.getElementById("user-email").value = inviteEmail;
            const signinEmailInput = document.getElementById("signin-email");
            if (signinEmailInput && !signinEmailInput.value) {
                signinEmailInput.value = inviteEmail;
            }
        }
        showJoinSection();
        showToast("Invitation Link Opened!", `Trip Code: ${tripId}. Click Join Group to start sharing coordinates.`, "success");
    }
    lucide.createIcons();
});

// Handle Form Submissions
document.getElementById("create-trip-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tripName = document.getElementById("trip-name").value.trim();
    const emailsInput = document.getElementById("member-emails").value;
    const emails = emailsInput ? emailsInput.split(",").map(email => email.trim()).filter(Boolean) : [];
    
    let dest = selectedDestination;

    if (!dest) {
        const query = searchInput.value.trim();
        if (!query) {
            showToast("Destination Required", "Please enter a destination to search.", "info");
            return;
        }

        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`);
            const data = await res.json();
            if (data && data.length > 0) {
                const item = data[0];
                selectDestinationItem(item);
                dest = selectedDestination;
            } else {
                showToast("Location Not Found", "Could not resolve destination location.", "bike");
                return;
            }
        } catch (err) {
            console.error("Auto destination lookup error:", err);
            showToast("Destination Required", "Please select a valid destination.", "bike");
            return;
        }
    }

    if (!dest) return;
    
    socket.emit("create-trip", {
        tripName,
        destination: dest,
        emails,
        creatorName: authUser ? authUser.name : "A fellow rider",
        appUrl: window.location.origin
    });
});

// Handle In-Trip Real Email Invites
const inTripInviteForm = document.getElementById("in-trip-invite-form");
if (inTripInviteForm) {
    inTripInviteForm.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!activeTrip) return;
        const emailInput = document.getElementById("invite-more-emails");
        const email = emailInput.value.trim();
        if (!email) return;

        socket.emit("invite-members", {
            tripId: activeTrip.id,
            emails: [email],
            appUrl: window.location.origin
        });

        emailInput.value = "";
        showToast("Email Dispatched", `Real invitation email sent to ${email}!`, "success");
    });
}

document.getElementById("join-trip-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const tripId = document.getElementById("join-trip-id").value.trim().toUpperCase();
    const name = document.getElementById("user-name").value.trim();
    const email = document.getElementById("user-email").value.trim();
    const phone = document.getElementById("user-phone").value.trim();
    
    if (!myLocation) {
        showToast("Waiting for GPS", "Please allow location access before joining the trip.", "bike");
        return;
    }
    
    socket.emit("join-trip", {
        tripId,
        name,
        email,
        phone,
        location: myLocation
    });
});

// Clipboard Link Copy
document.getElementById("copy-trip-id").addEventListener("click", () => {
    if (!activeTrip) return;
    const inviteLink = `${window.location.origin}?tripId=${activeTrip.id}`;
    navigator.clipboard.writeText(inviteLink)
        .then(() => showToast("Copied Link!", "Sharing link copied to clipboard.", "success"))
        .catch(err => console.error("Could not copy text: ", err));
});

// Share Actions
document.getElementById("share-whatsapp-btn").addEventListener("click", () => {
    if (!activeTrip) return;
    const shareText = `Hey! Join our group ride "${activeTrip.name}" map on RiderSync: ${window.location.origin}?tripId=${activeTrip.id}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank");
});

document.getElementById("share-email-btn").addEventListener("click", () => {
    if (!activeTrip) return;
    const subject = `Join our RiderSync Trip Map: ${activeTrip.name}`;
    const body = `Hey!\n\nJoin our live coordinate sharing trip on RiderSync:\n${window.location.origin}?tripId=${activeTrip.id}\n\nLet's ride together safely!`;
    window.open(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_blank");
});

// Destination navigation
document.getElementById("nav-destination-btn").addEventListener("click", () => {
    if (!activeTrip || !activeTrip.destination) return;
    const dest = activeTrip.destination;
    let url = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}`;
    if (myLocation) {
        url += `&origin=${myLocation.latitude},${myLocation.longitude}`;
    }
    window.open(url, "_blank");
});
// Master Start Trip & GPS Broadcasting Control
const startTripBtn = document.getElementById("start-trip-btn");
const gpsStatusIndicator = document.getElementById("gps-status-indicator");
const simulateRideBtn = document.getElementById("simulate-ride-btn");

if (startTripBtn) {
    startTripBtn.addEventListener("click", () => {
        isTripTrackingActive = !isTripTrackingActive;
        
        if (isTripTrackingActive) {
            startTripBtn.classList.add("active-tracking");
            startTripBtn.innerHTML = `<i data-lucide="square"></i> Stop / Pause Trip GPS`;
            if (gpsStatusIndicator) {
                gpsStatusIndicator.className = "status-badge-live";
                gpsStatusIndicator.innerHTML = `🟢 Live GPS Tracking Active`;
            }
            
            if (myLocation) {
                socket.emit("send-location", myLocation);
                if (map) map.panTo([myLocation.latitude, myLocation.longitude]);
            }
            showToast("Trip Started! 🏍️", "Broadcasting real-time GPS coordinates to group map.", "success");
        } else {
            if (simulateTimer) {
                clearInterval(simulateTimer);
                simulateTimer = null;
                if (simulateRideBtn) {
                    simulateRideBtn.innerHTML = `<i data-lucide="navigation-2"></i> Simulate Ride`;
                }
            }
            
            startTripBtn.classList.remove("active-tracking");
            startTripBtn.innerHTML = `<i data-lucide="play-circle"></i> Start Trip & Broadcast GPS`;
            if (gpsStatusIndicator) {
                gpsStatusIndicator.className = "status-badge-offline";
                gpsStatusIndicator.innerHTML = `● GPS Paused`;
            }
            showToast("Trip GPS Paused", "Location broadcasting paused.", "info");
        }
        lucide.createIcons();
    });
}

// Simulate Ride Movement along calculated route (for testing GPS movement)
if (simulateRideBtn) {
    simulateRideBtn.addEventListener("click", () => {
        if (simulateTimer) {
            clearInterval(simulateTimer);
            simulateTimer = null;
            simulateRideBtn.innerHTML = `<i data-lucide="navigation-2"></i> Simulate Ride`;
            showToast("Simulation Stopped", "Manual simulation paused.", "info");
            lucide.createIcons();
            return;
        }

        let routePoints = [];
        if (typeof calculatedRoutes !== 'undefined' && calculatedRoutes && calculatedRoutes.length > 0 && calculatedRoutes[0].geometry) {
            routePoints = calculatedRoutes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        } else if (activeTrip && activeTrip.destination && myLocation) {
            const steps = 30;
            const startLat = myLocation.latitude;
            const startLng = myLocation.longitude;
            const endLat = activeTrip.destination.lat;
            const endLng = activeTrip.destination.lng;
            for (let i = 0; i <= steps; i++) {
                routePoints.push([
                    startLat + (endLat - startLat) * (i / steps),
                    startLng + (endLng - startLng) * (i / steps)
                ]);
            }
        }

        if (routePoints.length === 0) {
            showToast("No Route Found", "Please start a trip with a valid destination to simulate.", "info");
            return;
        }

        if (!isTripTrackingActive && startTripBtn) {
            startTripBtn.click();
        }

        simulateStepIdx = 0;
        simulateRideBtn.innerHTML = `<i data-lucide="square"></i> Stop Sim`;
        lucide.createIcons();

        const stepJump = Math.max(1, Math.floor(routePoints.length / 35));
        showToast("Ride Simulation Active 🚀", "Moving GPS position live along the road...", "success");

        simulateTimer = setInterval(() => {
            if (simulateStepIdx < routePoints.length) {
                const [lat, lng] = routePoints[simulateStepIdx];
                myLocation = { latitude: lat, longitude: lng };
                socket.emit("send-location", { latitude: lat, longitude: lng });
                if (map) map.panTo([lat, lng]);
                simulateStepIdx += stepJump;
            } else {
                clearInterval(simulateTimer);
                simulateTimer = null;
                simulateRideBtn.innerHTML = `<i data-lucide="navigation-2"></i> Simulate Ride`;
                lucide.createIcons();
                showToast("Destination Reached! 🎉", "Simulated trip completed successfully.", "success");
            }
        }, 1200);
    });
}

// Status Alert Buttons Click Handler
const statusButtons = document.querySelectorAll(".status-btn");
statusButtons.forEach(btn => {
    btn.addEventListener("click", () => {
        statusButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        
        currentStatus = btn.getAttribute("data-status");
        socket.emit("update-status", { status: currentStatus });
    });
});

// Group Chat Submit
document.getElementById("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const chatInput = document.getElementById("chat-input");
    const text = chatInput.value.trim();
    if (!text) return;
    
    socket.emit("send-chat-msg", { text });
    chatInput.value = "";
});

// Toast Manager
function showToast(title, message, type = "info") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    let emoji = "ℹ️";
    if (type === "fuel") emoji = "⛽";
    else if (type === "toilet") emoji = "🚾";
    else if (type === "bike") emoji = "🔧";
    else if (type === "success") emoji = "✅";
    
    toast.innerHTML = `
        <span class="toast-icon">${emoji}</span>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-msg">${message}</div>
        </div>
        <button class="toast-close">&times;</button>
    `;
    
    // Close button click handler
    toast.querySelector(".toast-close").addEventListener("click", () => {
        removeToast(toast);
    });
    
    container.appendChild(toast);
    
    // Auto remove
    setTimeout(() => {
        removeToast(toast);
    }, 6000);
}

function removeToast(toast) {
    if (!toast.parentNode) return;
    toast.classList.add("removing");
    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 300);
}

// Leaflet DivIcon Custom HTML Maker
function createRiderMarkerHtml(name, status) {
    let emoji = "🏍️";
    let statusClass = "normal";
    if (status === "fuel") { emoji = "⛽"; statusClass = "fuel"; }
    else if (status === "toilet") { emoji = "🚾"; statusClass = "toilet"; }
    else if (status === "bike") { emoji = "🔧"; statusClass = "bike"; }
    
    return `
        <div class="custom-rider-marker">
            <div class="rider-marker-pulse ${statusClass}"></div>
            <div class="rider-marker-pin ${statusClass}">
                <span class="rider-marker-icon">${emoji}</span>
            </div>
            <span class="rider-marker-label">${name}</span>
        </div>
    `;
}

// Google Maps Multi-Route Engine & Live ETA Calculator
let calculatedRoutes = [];
let activeRouteIndex = 0;
let routePolylines = [];
let lastRouteFetchKey = "";

function calcHaversineDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return (R * c).toFixed(1);
}

function fetchAndRenderMultiRoutes(startLocation, endLocation) {
    if (!startLocation || !endLocation) return;

    const fetchKey = `${startLocation.latitude.toFixed(3)},${startLocation.longitude.toFixed(3)}-${endLocation.lat.toFixed(3)},${endLocation.lng.toFixed(3)}`;
    if (lastRouteFetchKey === fetchKey && calculatedRoutes.length > 0) return;
    lastRouteFetchKey = fetchKey;

    const url = `https://router.project-osrm.org/route/v1/driving/${startLocation.longitude},${startLocation.latitude};${endLocation.lng},${endLocation.lat}?overview=full&geometries=geojson&alternatives=true`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            if (data && data.routes && data.routes.length > 0) {
                calculatedRoutes = data.routes;
                activeRouteIndex = 0;
                renderRoutesOnMap();
            }
        })
        .catch(err => console.error("[MULTI ROUTE FETCH ERROR]", err));
}

function renderRoutesOnMap() {
    routePolylines.forEach(p => map.removeLayer(p));
    routePolylines = [];

    const pillsContainer = document.getElementById("route-selector-pills");
    if (pillsContainer) pillsContainer.innerHTML = "";

    if (!calculatedRoutes || calculatedRoutes.length === 0) return;

    document.getElementById("route-info-bar").classList.remove("hidden");

    calculatedRoutes.forEach((route, idx) => {
        const isSelected = (idx === activeRouteIndex);
        const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
        
        // Google Maps Colors: Active = Google Blue (#4285F4), Alternative = Translucent Gray (#9AA0A6)
        const polyline = L.polyline(coords, {
            color: isSelected ? "#4285F4" : "#9AA0A6",
            weight: isSelected ? 6 : 4,
            opacity: isSelected ? 0.95 : 0.6,
            dashArray: isSelected ? null : "6, 8",
            lineJoin: "round"
        }).addTo(map);

        if (isSelected) {
            polyline.bringToFront();
        }

        // Clicking alternative route line on map switches active route
        polyline.on("click", (e) => {
            L.DomEvent.stopPropagation(e);
            activeRouteIndex = idx;
            renderRoutesOnMap();
            const dur = Math.round(route.duration / 60);
            showToast("Route Selected", `Switched to ${idx === 0 ? "Fastest Route" : "Alternative Route " + idx} (${dur} min)`, "info");
        });

        routePolylines.push(polyline);

        // Build Route Selector Pill
        if (pillsContainer) {
            const distanceKm = (route.distance / 1000).toFixed(1);
            const durationMin = Math.round(route.duration / 60);
            
            const pill = document.createElement("div");
            pill.className = `route-pill ${isSelected ? "active" : ""}`;
            pill.innerHTML = `
                <span class="route-pill-eta">${durationMin} min</span>
                <span class="route-pill-dist">(${distanceKm} km)</span>
                ${idx === 0 ? '<span style="font-size:10px; margin-left:2px; font-weight:700;">⚡ FASTEST</span>' : ''}
            `;

            pill.addEventListener("click", () => {
                activeRouteIndex = idx;
                renderRoutesOnMap();
            });

            pillsContainer.appendChild(pill);
        }
    });

    const activeRoute = calculatedRoutes[activeRouteIndex];
    if (activeRoute) {
        const dist = (activeRoute.distance / 1000).toFixed(1);
        const dur = Math.round(activeRoute.duration / 60);
        const arrivalTime = new Date(Date.now() + activeRoute.duration * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        document.getElementById("route-info-text").textContent = `Google Maps Route • ${dur} mins (${dist} km) • ETA ${arrivalTime}`;
    }
}

// Sync active riders list and route polylines on UI
function syncTripData(trip) {
    // 1. Destination pin and lines
    if (trip.destination) {
        const dest = trip.destination;
        document.getElementById("dest-address").textContent = dest.address || "Live coordinates destination";
        
        // Render or update destination marker
        if (!destMarker) {
            const destIcon = L.divIcon({
                className: "dest-marker",
                html: `<div class="dest-marker-pin">🚩</div>`,
                iconSize: [32, 32],
                iconAnchor: [16, 32]
            });
            destMarker = L.marker([dest.lat, dest.lng], { icon: destIcon }).addTo(map);
            destMarker.bindPopup(`<b>Destination:</b><br>${dest.address}`);
        } else {
            destMarker.setLatLng([dest.lat, dest.lng]);
        }
        
        document.getElementById("route-info-bar").classList.remove("hidden");
    }
    
    // 2. Set Up/Update Riders markers, popups & navigation lines
    const members = trip.members;
    const membersListUl = document.getElementById("members-list");
    membersListUl.innerHTML = "";
    document.getElementById("member-count").textContent = Object.keys(members).length;
    
    // Build list item & draw map nodes
    Object.keys(members).forEach(socketId => {
        const m = members[socketId];
        if (m.latitude && m.longitude) {
            // Update Marker
            if (markers[socketId]) {
                markers[socketId].setLatLng([m.latitude, m.longitude]);
                
                const customIcon = L.divIcon({
                    className: "rider-marker",
                    html: createRiderMarkerHtml(m.name, m.status),
                    iconSize: [36, 36],
                    iconAnchor: [18, 18]
                });
                markers[socketId].setIcon(customIcon);
            } else {
                const customIcon = L.divIcon({
                    className: "rider-marker",
                    html: createRiderMarkerHtml(m.name, m.status),
                    iconSize: [36, 36],
                    iconAnchor: [18, 18]
                });
                markers[socketId] = L.marker([m.latitude, m.longitude], { icon: customIcon }).addTo(map);
                markers[socketId].bindPopup(`<b>${m.name}</b><br>Status: ${m.status.toUpperCase()}`);
            }
            
            // Trigger multi-route calculations for active user
            if (socketId === socket.id && trip.destination) {
                fetchAndRenderMultiRoutes({ latitude: m.latitude, longitude: m.longitude }, trip.destination);
            }
        }
        
        // Add to active sidebar list
        const li = document.createElement("li");
        li.className = "member-item";
        
        let statusBadge = "normal";
        let statusText = "Active Rider";
        if (m.status === "fuel") { statusBadge = "fuel"; statusText = "Stopped for Fuel"; }
        else if (m.status === "toilet") { statusBadge = "toilet"; statusText = "Toilet Break"; }
        else if (m.status === "bike") { statusBadge = "bike"; statusText = "Bike Issue / Breakdown"; }
        
        const avatarLetter = m.name[0].toUpperCase();

        let etaInfoHtml = "";
        if (m.latitude && m.longitude && trip.destination) {
            const distKm = calcHaversineDistanceKm(m.latitude, m.longitude, trip.destination.lat, trip.destination.lng);
            const estMinutes = Math.max(1, Math.round((distKm / 45) * 60));
            etaInfoHtml = `<div class="member-eta-badge">📍 ${distKm} km • ~${estMinutes} min ETA</div>`;
        }
        
        li.innerHTML = `
            <div class="member-info">
                <div class="avatar-wrapper">
                    <div class="avatar">${avatarLetter}</div>
                    <div class="avatar-status-badge ${statusBadge}"></div>
                </div>
                <div class="member-text">
                    <div class="member-name">${m.name} ${socketId === socket.id ? "(You)" : ""}</div>
                    <div class="member-status-text">${statusText}</div>
                    ${etaInfoHtml}
                </div>
            </div>
            <div class="member-actions">
                <button class="action-btn-mini nav" title="Navigate to rider"><i data-lucide="navigation-2"></i></button>
                ${m.phone ? `<a href="tel:${m.phone}" class="action-btn-mini call" title="Call rider"><i data-lucide="phone"></i></a>` : ""}
                ${m.phone ? `<a href="https://wa.me/${m.phone.replace(/[^0-9+]/g, '')}" target="_blank" class="action-btn-mini whatsapp" title="WhatsApp rider"><i data-lucide="message-square"></i></a>` : ""}
            </div>
        `;
        
        // Action Handlers
        // Center on rider clicking the member item
        li.querySelector(".member-info").addEventListener("click", (e) => {
            if (m.latitude && m.longitude) {
                map.setView([m.latitude, m.longitude], 16);
                markers[socketId].openPopup();
            }
        });
        
        // Navigation button clicked
        li.querySelector(".action-btn-mini.nav").addEventListener("click", (e) => {
            e.stopPropagation();
            if (!m.latitude || !m.longitude) return;
            let url = `https://www.google.com/maps/dir/?api=1&destination=${m.latitude},${m.longitude}`;
            if (myLocation) {
                url += `&origin=${myLocation.latitude},${myLocation.longitude}`;
            }
            window.open(url, "_blank");
        });
        
        membersListUl.appendChild(li);
    });
    
    // Clean up markers and lines for members who disconnected
    Object.keys(markers).forEach(id => {
        if (!members[id]) {
            map.removeLayer(markers[id]);
            delete markers[id];
            
            if (destRouteLines[id]) {
                if (typeof L.Routing !== 'undefined' && destRouteLines[id] instanceof L.Routing.Control) {
                    map.removeControl(destRouteLines[id]);
                } else {
                    map.removeLayer(destRouteLines[id]);
                }
                delete destRouteLines[id];
            }
        }
    });
    
    lucide.createIcons();
}

// Socket Receivers
socket.on("trip-created", (data) => {
    const { tripId, tripName, invitesSentCount } = data;
    
    // Append tripId query parameter to URL without reloading
    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?tripId=${tripId}`;
    window.history.pushState({ path: newUrl }, "", newUrl);
    
    const creatorName = authUser ? (authUser.name || authUser.email.split('@')[0]) : "Trip Host";
    const creatorEmail = authUser ? authUser.email : "";

    document.getElementById("join-trip-id").value = tripId;

    if (myLocation) {
        // Auto-join creator immediately into the live trip map
        socket.emit("join-trip", {
            tripId,
            name: creatorName,
            email: creatorEmail,
            location: myLocation
        });
    } else {
        showJoinSection();
    }

    const toastMsg = invitesSentCount > 0 
        ? `"${tripName}" created! Email invitation(s) sent to ${invitesSentCount} member(s).` 
        : `"${tripName}" initialized with Code: ${tripId}.`;

    showToast("Trip Initialized!", toastMsg, "success");
});

socket.on("members-invited", (data) => {
    showToast("Members Invited", `${data.invitedBy} sent real email invitation(s) for this trip!`, "success");
});

socket.on("trip-updated", (trip) => {
    activeTrip = trip;
    
    // Transition sections: Hide setup, show live tracking controls
    createSection.classList.remove("active");
    createSection.classList.add("hidden");
    joinSection.classList.remove("active");
    joinSection.classList.add("hidden");
    
    const activeSection = document.getElementById("active-trip-section");
    activeSection.classList.remove("hidden");
    activeSection.classList.add("active");
    
    // Update labels
    document.getElementById("active-trip-title").textContent = trip.name;
    document.getElementById("active-trip-id-display").textContent = trip.id;
    document.getElementById("toggle-section-link").classList.add("hidden"); // hide footer link
    
    // Reveal tracking status bars
    document.getElementById("status-control-bar").classList.remove("hidden");
    
    // Update map items
    syncTripData(trip);
});

socket.on("trip-error", (errMessage) => {
    showToast("Error", errMessage, "bike");
});

socket.on("status-alert", (data) => {
    const { name, status, latitude, longitude } = data;
    
    let type = "info";
    let message = "changed status";
    if (status === "fuel") { type = "fuel"; message = "stopped for Fuel! ⛽"; }
    else if (status === "toilet") { type = "toilet"; message = "stopped for Toilet! 🚾"; }
    else if (status === "bike") { type = "bike"; message = "is facing a Bike Issue! 🔧"; }
    
    showToast(`${name} Alert`, message, type);
    
    // Focus map on alerted rider
    if (latitude && longitude) {
        map.setView([latitude, longitude], 16);
    }
});

socket.on("member-joined", (data) => {
    showToast("Rider Joined", `${data.name} is now sharing coordinates.`, "success");
});

socket.on("member-left", (data) => {
    showToast("Rider Left", `${data.name} left the group map.`, "info");
});

// Chat handlers
socket.on("chat-msg-received", (msg) => {
    const chatContainer = document.getElementById("chat-messages");
    const isSelf = msg.socketId === socket.id;
    
    const div = document.createElement("div");
    div.className = `chat-msg ${isSelf ? "self" : "other"}`;
    div.innerHTML = `
        <span class="chat-msg-sender">${isSelf ? "You" : msg.sender}</span>
        <span class="chat-msg-text">${msg.text}</span>
        <span class="chat-msg-time">${msg.time}</span>
    `;
    
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
});

// Fallback logic for standalone location sharing (backward compatibility)
socket.on("recieve-location", (data) => {
    // If not in a trip, do simple general location drawing
    if (!activeTrip) {
        const { id, latitude, longitude } = data;
        map.setView([latitude, longitude], 15);

        if (markers[id]) {
            markers[id].setLatLng([latitude, longitude]);
        } else {
            markers[id] = L.marker([latitude, longitude]).addTo(map);
            markers[id].bindPopup("Anonymous Rider");
        }
    }
});

socket.on("user-disconnected", (id) => {
    if (!activeTrip && markers[id]) {
        map.removeLayer(markers[id]);
        delete markers[id];
    }
});