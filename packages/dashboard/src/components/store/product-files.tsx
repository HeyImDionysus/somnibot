/**
 * ProductFiles — File upload & management for store products.
 *
 * Displays existing files, allows drag-and-drop upload, delete, and version management.
 * Uses /api/store/files API.
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface ProductFile {
  id: string;
  product_id: string;
  file_name: string;
  display_name: string;
  description: string | null;
  version: string | null;
  file_size: number;
  content_type: string;
  storage_path: string;
  download_count: number;
  sort_order: number;
  created_at: string;
}

interface Props {
  productId: string;
  productName: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function fileIcon(contentType: string): string {
  if (contentType.startsWith('image/')) return '🖼️';
  if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('7z')) return '📦';
  if (contentType.includes('pdf')) return '📄';
  if (contentType.includes('video')) return '🎬';
  if (contentType.includes('audio')) return '🎵';
  if (contentType.includes('text') || contentType.includes('json') || contentType.includes('xml')) return '📝';
  return '📁';
}

export default function ProductFiles({ productId, productName }: Props) {
  const [files, setFiles] = useState<ProductFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/store/files?product_id=${productId}`);
      const json = await res.json();
      if (json.success) setFiles(json.data ?? []);
    } catch (err) {
      console.error('Failed to load files:', err);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const uploadFile = async (file: File) => {
    if (file.size > 100 * 1024 * 1024) {
      setError('File too large (max 100MB)');
      return;
    }

    setUploading(true);
    setUploadProgress(`Uploading ${file.name}...`);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('product_id', productId);
      formData.append('display_name', file.name);

      const res = await fetch('/api/store/files', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (json.success) {
        await fetchFiles();
        setUploadProgress(null);
      } else {
        setError(json.error || 'Upload failed');
      }
    } catch (err) {
      setError('Upload failed — check your connection');
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const deleteFile = async (fileId: string, fileName: string) => {
    if (!confirm(`Delete "${fileName}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/store/files?file_id=${fileId}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (json.success) {
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
      } else {
        setError(json.error || 'Delete failed');
      }
    } catch (err) {
      setError('Delete failed');
      console.error('Delete error:', err);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      uploadFile(droppedFiles[0]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) uploadFile(selected);
    e.target.value = '';
  };

  return (
    <div className="bg-discord-secondary rounded-lg border border-discord-border">
      <div className="p-4 border-b border-discord-border">
        <h3 className="text-sm font-semibold text-white">
          📁 Files for &quot;{productName}&quot;
        </h3>
        <p className="text-xs text-discord-text-muted mt-1">
          Upload product files that customers can download after purchase.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-xs">
          {error}
          <button onClick={() => setError(null)} className="float-right text-red-300 hover:text-white">✕</button>
        </div>
      )}

      {/* Upload zone */}
      <div
        className={`m-4 border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
          dragOver
            ? 'border-discord-blurple bg-discord-blurple/10'
            : 'border-discord-border hover:border-discord-text-muted'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileSelect}
          className="hidden"
        />
        {uploading ? (
          <div>
            <p className="text-sm text-discord-blurple animate-pulse">{uploadProgress}</p>
          </div>
        ) : (
          <div>
            <p className="text-2xl mb-2">📤</p>
            <p className="text-sm text-discord-text-muted">
              Drag & drop a file here, or <span className="text-discord-blurple">click to browse</span>
            </p>
            <p className="text-xs text-discord-text-muted mt-1">Max 100MB per file</p>
          </div>
        )}
      </div>

      {/* File list */}
      <div className="px-4 pb-4">
        {loading ? (
          <p className="text-discord-text-muted text-xs text-center py-4">Loading files...</p>
        ) : files.length === 0 ? (
          <p className="text-discord-text-muted text-xs text-center py-4">
            No files uploaded yet
          </p>
        ) : (
          <div className="space-y-2">
            {files.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between bg-discord-tertiary rounded-lg px-3 py-2.5 group"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <span className="text-lg flex-shrink-0">{fileIcon(f.content_type)}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{f.display_name}</p>
                    <div className="flex items-center gap-2 text-xs text-discord-text-muted">
                      <span>{formatBytes(f.file_size)}</span>
                      {f.version && <span>v{f.version}</span>}
                      <span>•</span>
                      <span>{f.download_count} download{f.download_count !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteFile(f.id, f.display_name); }}
                  className="text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity text-sm px-2"
                  title="Delete file"
                >
                  🗑️
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
