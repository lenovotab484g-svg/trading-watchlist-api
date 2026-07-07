import User from '../models/User.js';
import SMSVerification from '../models/SMSVerification.js';
import RefreshToken from '../models/RefreshToken.js';
import Watchlist from '../models/Watchlist.js';
import { generateSMSCode, sendSMS } from '../utils/sms.js';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt.js';
import { logger } from '../utils/logger.js';

export const requestSMSCode = async (req, res) => {
  try {
    const { phone } = req.validatedData;

    // Generate and send SMS code
    const code = generateSMSCode();
    
    // Check if verification already exists
    const existingVerification = await SMSVerification.findOne({ phone });
    if (existingVerification) {
      await SMSVerification.deleteOne({ _id: existingVerification._id });
    }

    // Save verification code
    const verification = new SMSVerification({
      phone,
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    });
    await verification.save();

    // Send SMS (replace with actual SMS service)
    await sendSMS(phone, `Your verification code is: ${code}`);

    logger.info(`SMS code sent to ${phone}`);

    return res.status(200).json({
      message: 'SMS code sent successfully',
      phone: phone.slice(-4).padStart(phone.length, '*') // Masked phone
    });
  } catch (error) {
    logger.error('Request SMS code error:', error);
    return res.status(500).json({ message: 'Failed to send SMS code' });
  }
};

export const verifySMSCode = async (req, res) => {
  try {
    const { phone, code, referralCode, deviceId, deviceName } = req.validatedData;

    // Verify SMS code
    const verification = await SMSVerification.findOne({ phone, code });

    if (!verification) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    if (verification.attempts >= 3) {
      await SMSVerification.deleteOne({ _id: verification._id });
      return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
    }

    // Check if user exists
    let user = await User.findOne({ phone });

    if (!user) {
      // Create new user with 3 days free subscription
      user = new User({
        phone,
        isVerified: true,
        subscription: {
          type: 'single',
          duration: '1month',
          startDate: new Date(),
          endDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) // 3 days free trial
        }
      });

      // Handle referral
      if (referralCode) {
        const referrer = await User.findOne({ referralCode });
        if (referrer) {
          user.referredBy = referrer._id;
          referrer.children.push(user._id);
          await referrer.save();
        }
      }

      await user.save();

      // Create default watchlist
      const defaultWatchlist = new Watchlist({
        userId: user._id,
        name: 'My Watchlist',
        isDefault: true,
        order: 0
      });
      await defaultWatchlist.save();

      logger.info(`New user registered: ${phone}`);
    }

    // Check session limit
    if (user.subscription.type === 'single' && user.activeSessions.length >= 1) {
      // Remove previous session if single subscription
      user.activeSessions = [];
    } else if (user.subscription.type === 'multi' && user.activeSessions.length >= user.subscription.maxDevices) {
      return res.status(429).json({ message: 'Maximum device limit reached' });
    }

    // Add new session
    user.activeSessions.push({
      deviceId,
      deviceName,
      loginTime: new Date(),
      lastActivityTime: new Date()
    });
    user.lastLogin = new Date();
    await user.save();

    // Generate tokens
    const accessToken = generateAccessToken(user._id, deviceId);
    const refreshToken = generateRefreshToken(user._id, deviceId);

    // Save refresh token
    const refreshTokenDoc = new RefreshToken({
      userId: user._id,
      token: refreshToken,
      deviceId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });
    await refreshTokenDoc.save();

    // Delete verification code
    await SMSVerification.deleteOne({ _id: verification._id });

    logger.info(`User ${phone} verified and logged in`);

    return res.status(200).json({
      message: user.isVerified && user.phone === phone ? 'Login successful' : 'Registration successful',
      user: {
        id: user._id,
        phone: user.phone,
        referralCode: user.referralCode
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: '3h'
      }
    });
  } catch (error) {
    logger.error('Verify SMS code error:', error);
    return res.status(500).json({ message: 'Failed to verify code' });
  }
};

export const refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken, deviceId } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' });
    }

    // Find and verify refresh token
    const tokenDoc = await RefreshToken.findOne({ token: refreshToken });

    if (!tokenDoc || new Date() > tokenDoc.expiresAt) {
      return res.status(401).json({ message: 'Invalid or expired refresh token' });
    }

    // Generate new access token
    const newAccessToken = generateAccessToken(tokenDoc.userId, deviceId);

    return res.status(200).json({
      accessToken: newAccessToken,
      expiresIn: '3h'
    });
  } catch (error) {
    logger.error('Refresh token error:', error);
    return res.status(500).json({ message: 'Failed to refresh token' });
  }
};

export const getUser = async (req, res) => {
  try {
    const userId = req.userId;

    // Find user and populate referral info
    const user = await User.findById(userId)
      .select('-__v')
      .populate({
        path: 'referredBy',
        select: 'phone referralCode'
      })
      .populate({
        path: 'children',
        select: 'phone referralCode createdAt'
      });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if subscription is active
    const isSubscriptionActive = user.subscription.isActive && new Date() <= user.subscription.endDate;

    const userInfo = {
      id: user._id,
      phone: user.phone,
      referralCode: user.referralCode,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      referredBy: user.referredBy,
      childrenCount: user.children.length,
      subscription: {
        type: user.subscription.type,
        duration: user.subscription.duration,
        startDate: user.subscription.startDate,
        endDate: user.subscription.endDate,
        isActive: isSubscriptionActive,
        daysRemaining: isSubscriptionActive 
          ? Math.ceil((user.subscription.endDate - new Date()) / (1000 * 60 * 60 * 24))
          : 0,
        maxDevices: user.subscription.maxDevices
      },
      activeSessions: user.activeSessions.map(session => ({
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        loginTime: session.loginTime,
        lastActivityTime: session.lastActivityTime
      }))
    };

    logger.info(`User profile retrieved: ${user.phone}`);

    return res.status(200).json({
      message: 'User information retrieved successfully',
      user: userInfo
    });
  } catch (error) {
    logger.error('Get user error:', error);
    return res.status(500).json({ message: 'Failed to retrieve user information' });
  }
};
