import Joi from 'joi';

export const phoneSchema = Joi.object({
  phone: Joi.string()
    .pattern(/^[0-9]{10,15}$/)
    .required()
    .messages({
      'string.pattern.base': 'Phone number must be between 10-15 digits'
    })
});

export const verifyCodeSchema = Joi.object({
  phone: Joi.string()
    .pattern(/^[0-9]{10,15}$/)
    .required(),
  code: Joi.string().length(5).pattern(/^[0-9]+$/).required().messages({
    'string.pattern.base': 'Code must contain only digits',
    'string.length': 'Code must be exactly 5 digits'
  }),
  referralCode: Joi.string().allow(null, ''),
  deviceId: Joi.string().required(),
  deviceName: Joi.string().required()
});

export const watchlistSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  symbols: Joi.array().items(Joi.string())
});

export const symbolSchema = Joi.object({
  code: Joi.string().uppercase().required(),
  name: Joi.string().required(),
  type: Joi.string()
    .valid('stock', 'crypto', 'forex', 'commodity', 'currency')
    .required(),
  market: Joi.string()
});

export const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        errors: error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message
        }))
      });
    }

    req.validatedData = value;
    next();
  };
};
