import React, { useState, useRef, useEffect } from 'react';
import PropTypes from 'prop-types';

const CustomDatePicker = ({ value, onChange, placeholder = "Select date" }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date(value || new Date()));
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = (year, month) => new Date(year, month, 1).getDay();

  const handlePrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const onDateClick = (day) => {
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const date = String(day).padStart(2, '0');
    const formattedDate = `${year}-${month}-${date}`;
    onChange(formattedDate);
    setIsOpen(false);
  };

  const renderDays = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const totalDays = daysInMonth(year, month);
    const firstDay = firstDayOfMonth(year, month);
    const days = [];

    // Fill leading empty days
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="datepicker-day empty"></div>);
    }

    // Fill actual days
    for (let d = 1; d <= totalDays; d++) {
      const isSelected = value === `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = new Date().toDateString() === new Date(year, month, d).toDateString();

      days.push(
        <button
          type="button"
          key={d}
          className={`datepicker-day native-el ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`}
          onClick={() => onDateClick(d)}
        >
          {d}
        </button>
      );
    }

    return days;
  };

  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  return (
    <div className="custom-datepicker-container" ref={containerRef}>
      <button type="button" className="date-display-input native-el" onClick={() => setIsOpen(!isOpen)}>
        <span>{value || placeholder}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
      </button>

      {isOpen && (
        <div className="datepicker-popup">
          <div className="datepicker-header">
            <button className="datepicker-nav-btn" onClick={handlePrevMonth}>&lt;</button>
            <span>{monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}</span>
            <button className="datepicker-nav-btn" onClick={handleNextMonth}>&gt;</button>
          </div>

          <div className="datepicker-grid">
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
              <div key={day} className="datepicker-day-label">{day}</div>
            ))}
            {renderDays()}
          </div>

          <div className="datepicker-footer">
            <button className="datepicker-footer-btn" onClick={() => { onChange(''); setIsOpen(false); }}>Clear</button>
            <button className="datepicker-footer-btn" onClick={() => {
              const now = new Date();
              const year = now.getFullYear();
              const month = String(now.getMonth() + 1).padStart(2, '0');
              const date = String(now.getDate()).padStart(2, '0');
              onChange(`${year}-${month}-${date}`);
              setIsOpen(false);
            }}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
};

CustomDatePicker.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  placeholder: PropTypes.string,
};

export default CustomDatePicker;
