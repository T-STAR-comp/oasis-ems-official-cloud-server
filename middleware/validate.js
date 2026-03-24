import { body, param, query, validationResult } from 'express-validator';
import { isSupportedGradingSystem } from '../utils/education.js';

// Middleware to check validation results
export function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.path,
        message: err.msg
      }))
    });
  }
  next();
}

// Sanitize string to prevent XSS
function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[<>]/g, '') // Remove angle brackets
    .trim();
}

// User validation rules
export const userValidation = {
  register: [
    body('username')
      .trim()
      .isLength({ min: 3, max: 50 }).withMessage('Username must be 3-50 characters')
      .isAlphanumeric().withMessage('Username must be alphanumeric')
      .customSanitizer(sanitizeString),
    body('email')
      .trim()
      .isEmail().withMessage('Invalid email address')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain a lowercase letter')
      .matches(/[0-9]/).withMessage('Password must contain a number'),
    body('full_name')
      .optional()
      .trim()
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('role')
      .optional()
      .isIn(['admin', 'teacher', 'secretary']).withMessage('Invalid role'),
    handleValidation
  ],
  login: [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
    body('school_id')
      .optional({ nullable: true })
      .trim()
      .isLength({ min: 6, max: 64 }).withMessage('School ID must be 6-64 characters'),
    body('deployment_mode')
      .optional({ nullable: true })
      .isIn(['admin_setup', 'teacher_setup', 'user_login']).withMessage('Invalid deployment mode'),
    handleValidation
  ]
};

// Class validation rules
export const classValidation = {
  create: [
    body('name')
      .trim()
      .notEmpty().withMessage('Class name is required')
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('year')
      .trim()
      .notEmpty().withMessage('Year is required')
      .matches(/^\d{4}$/).withMessage('Year must be a 4-digit number'),
    body('min_subjects')
      .optional()
      .isInt({ min: 1 }).withMessage('Minimum subjects must be at least 1'),
    body('max_subjects')
      .optional()
      .isInt({ min: 1 }).withMessage('Maximum subjects must be at least 1'),
    handleValidation
  ],
  update: [
    param('id').notEmpty().withMessage('Class ID is required'),
    body('name')
      .optional()
      .trim()
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('year')
      .optional()
      .trim()
      .matches(/^\d{4}$/).withMessage('Year must be a 4-digit number'),
    body('min_subjects')
      .optional()
      .isInt({ min: 1 }).withMessage('Minimum subjects must be at least 1'),
    body('max_subjects')
      .optional()
      .isInt({ min: 1 }).withMessage('Maximum subjects must be at least 1'),
    handleValidation
  ]
};

// Student validation rules
export const studentValidation = {
  create: [
    body('class_id').notEmpty().withMessage('Class ID is required'),
    body('name')
      .trim()
      .notEmpty().withMessage('Student name is required')
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('gender')
      .isIn(['Male', 'Female']).withMessage('Gender must be Male or Female'),
    body('date_of_birth')
      .optional()
      .isISO8601().withMessage('Invalid date format'),
    body('guardian_name')
      .optional()
      .trim()
      .isLength({ max: 100 }).withMessage('Guardian name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('guardian_phone')
      .optional()
      .trim()
      .isLength({ max: 20 }).withMessage('Phone must be less than 20 characters'),
    body('admission_number')
      .optional()
      .trim()
      .isLength({ max: 50 }).withMessage('Admission number must be less than 50 characters')
      .customSanitizer(sanitizeString),
    body('subject_ids')
      .optional()
      .isArray().withMessage('subject_ids must be an array'),
    handleValidation
  ],
  update: [
    param('id').notEmpty().withMessage('Student ID is required'),
    body('name')
      .optional()
      .trim()
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('gender')
      .optional()
      .isIn(['Male', 'Female']).withMessage('Gender must be Male or Female'),
    body('subject_ids')
      .optional()
      .isArray().withMessage('subject_ids must be an array'),
    handleValidation
  ]
};

// Subject validation rules
export const subjectValidation = {
  create: [
    body('class_id').notEmpty().withMessage('Class ID is required'),
    body('name')
      .trim()
      .notEmpty().withMessage('Subject name is required')
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('code')
      .trim()
      .notEmpty().withMessage('Subject code is required')
      .isLength({ max: 20 }).withMessage('Code must be less than 20 characters')
      .customSanitizer(sanitizeString),
    body('is_compulsory')
      .optional()
      .isBoolean().withMessage('is_compulsory must be a boolean'),
    handleValidation
  ]
};

// Exam validation rules
export const examValidation = {
  create: [
    body('class_id').notEmpty().withMessage('Class ID is required'),
    body('name')
      .trim()
      .notEmpty().withMessage('Exam name is required')
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters')
      .customSanitizer(sanitizeString),
    body('type')
      .isIn(['test', 'midterm', 'endterm']).withMessage('Invalid exam type'),
    body('term')
      .trim()
      .notEmpty().withMessage('Term is required')
      .isLength({ max: 50 }).withMessage('Term must be less than 50 characters'),
    body('year')
      .trim()
      .notEmpty().withMessage('Year is required')
      .matches(/^\d{4}$/).withMessage('Year must be a 4-digit number'),
    body('grading_system')
      .optional()
      .custom((value) => {
        if (!isSupportedGradingSystem(value)) {
          throw new Error('Invalid grading system');
        }
        return true;
      }),
    body('component_exam_id')
      .optional({ nullable: true })
      .isString().withMessage('Component exam ID must be a string'),
    body('merge_exam_ids')
      .optional()
      .isArray().withMessage('merge_exam_ids must be an array'),
    body('merge_exam_ids.*')
      .optional()
      .isString().withMessage('Each merge exam ID must be a string'),
    body('component_weight')
      .optional()
      .isFloat({ min: 0, max: 100 }).withMessage('Component weight must be between 0 and 100'),
    body('current_weight')
      .optional()
      .isFloat({ min: 0, max: 100 }).withMessage('Current weight must be between 0 and 100'),
    body('max_score')
      .optional()
      .isFloat({ min: 1 }).withMessage('Max score must be at least 1'),
    handleValidation
  ],
  addResult: [
    body("results")
      .isArray({ min: 1 })
      .withMessage("Results must be an array"),
  
    body("results.*.student_id")
      .notEmpty()
      .withMessage("Student ID is required"),
  
    body("results.*.subject_id")
      .notEmpty()
      .withMessage("Subject ID is required"),
  
    body("results.*.score")
      .isFloat({ min: 0 })
      .withMessage("Score must be zero or greater"),
  
    handleValidation
  ]
  
};

// ID parameter validation
export const idValidation = [
  param('id').notEmpty().withMessage('ID is required'),
  handleValidation
];
