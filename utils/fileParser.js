import xlsx from 'xlsx';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs';

export async function parseExcelFile(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
  
  if (data.length < 2) {
    return { headers: [], rows: [], students: [] };
  }

  const headers = data[0].map(h => String(h || '').toLowerCase().trim());
  const rows = data.slice(1).filter(row => row.some(cell => cell != null && cell !== ''));

  // Auto-map columns to student fields
  const students = rows.map(row => {
    const student = {
      name: '',
      gender: 'Male',
      date_of_birth: null,
      guardian_name: null,
      guardian_phone: null,
      admission_number: null
    };

    headers.forEach((header, index) => {
      const value = row[index] != null ? String(row[index]).trim() : '';
      
      if (header.includes('name') && !header.includes('guardian')) {
        student.name = value;
      } else if (header.includes('gender') || header.includes('sex')) {
        student.gender = value.toLowerCase().startsWith('f') ? 'Female' : 'Male';
      } else if (header.includes('dob') || header.includes('birth') || header.includes('date')) {
        student.date_of_birth = value || null;
      } else if (header.includes('guardian') && header.includes('name')) {
        student.guardian_name = value || null;
      } else if (header.includes('guardian') && (header.includes('phone') || header.includes('contact'))) {
        student.guardian_phone = value || null;
      } else if (header.includes('admission') || header.includes('reg') || header.includes('number')) {
        student.admission_number = value || null;
      }
    });

    return student;
  }).filter(s => s.name);

  return { headers, rows, students };
}

export async function parsePDFFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  const text = data.text;

  // Try to extract student data from PDF text
  const lines = text.split('\n').filter(l => l.trim());
  const students = [];

  // Simple heuristic: look for lines that might contain student data
  // This is a basic implementation - real-world PDFs vary greatly
  for (const line of lines) {
    // Skip header-like lines
    if (line.toLowerCase().includes('name') && line.toLowerCase().includes('gender')) {
      continue;
    }

    // Try to parse comma or tab separated values
    const parts = line.split(/[,\t]+/).map(p => p.trim()).filter(p => p);
    
    if (parts.length >= 2) {
      const student = {
        name: parts[0],
        gender: 'Male',
        date_of_birth: null,
        guardian_name: null,
        guardian_phone: null,
        admission_number: null
      };

      // Try to identify gender
      for (const part of parts) {
        if (part.toLowerCase() === 'female' || part.toLowerCase() === 'f') {
          student.gender = 'Female';
        }
        if (part.toLowerCase() === 'male' || part.toLowerCase() === 'm') {
          student.gender = 'Male';
        }
      }

      // Only add if name looks valid (at least 2 chars, contains letters)
      if (student.name.length >= 2 && /[a-zA-Z]/.test(student.name)) {
        students.push(student);
      }
    }
  }

  return { text, students };
}

export async function parseWordFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value;

  // Try to extract from tables or structured text
  const lines = text.split('\n').filter(l => l.trim());
  const students = [];

  for (const line of lines) {
    // Skip header-like lines
    if (line.toLowerCase().includes('name') && 
        (line.toLowerCase().includes('gender') || line.toLowerCase().includes('class'))) {
      continue;
    }

    // Try to parse tab or multiple space separated values
    const parts = line.split(/\t+|\s{2,}/).map(p => p.trim()).filter(p => p);
    
    if (parts.length >= 1 && parts[0].length >= 2) {
      const student = {
        name: parts[0],
        gender: 'Male',
        date_of_birth: null,
        guardian_name: null,
        guardian_phone: null,
        admission_number: null
      };

      // Try to identify other fields
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i].toLowerCase();
        if (part === 'female' || part === 'f') {
          student.gender = 'Female';
        } else if (part === 'male' || part === 'm') {
          student.gender = 'Male';
        }
      }

      // Only add if name looks valid
      if (/[a-zA-Z]/.test(student.name) && !student.name.toLowerCase().includes('student')) {
        students.push(student);
      }
    }
  }

  return { text, students };
}

export async function parseFile(filePath, mimeType) {
  const ext = filePath.split('.').pop().toLowerCase();

  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || 
      mimeType?.includes('spreadsheet') || mimeType?.includes('excel') || mimeType === 'text/csv') {
    return await parseExcelFile(filePath);
  } else if (ext === 'pdf' || mimeType === 'application/pdf') {
    return await parsePDFFile(filePath);
  } else if (ext === 'docx' || ext === 'doc' || mimeType?.includes('word')) {
    return await parseWordFile(filePath);
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// Parse marks/results from Excel
export async function parseMarksExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
  
  if (data.length < 2) {
    return { headers: [], results: [] };
  }

  const headers = data[0].map(h => String(h || '').trim());
  const results = [];

  // First column is usually student name/ID, rest are subjects
  const subjectColumns = headers.slice(1);

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    const studentName = String(row[0]).trim();
    
    for (let j = 1; j < row.length && j <= subjectColumns.length; j++) {
      const score = parseFloat(row[j]);
      if (!isNaN(score) && score >= 0 && score <= 100) {
        results.push({
          studentName,
          subjectName: subjectColumns[j - 1],
          score
        });
      }
    }
  }

  return { headers: subjectColumns, results };
}
