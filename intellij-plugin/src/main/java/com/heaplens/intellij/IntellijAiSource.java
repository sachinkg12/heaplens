package com.heaplens.intellij;

import com.heaplens.ai.*;
import com.heaplens.source.SourceTarget;
import com.intellij.diff.DiffManager;
import com.intellij.diff.DiffRequestFactory;
import com.intellij.diff.InvalidDiffRequestException;
import com.intellij.diff.merge.MergeResult;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.*;
import com.intellij.openapi.fileEditor.*;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.ProjectFileIndex;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.util.text.StringUtil;
import com.intellij.openapi.vfs.VirtualFile;
import java.awt.event.ActionEvent;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.*;
import javax.swing.*;

/** Consent-before-read, isolated native merge preview, then explicit guarded application. */
final class IntellijAiSource implements AiSourcePort {
    private final Project project;
    private final Disposable owner;
    private final ProjectSourceNavigator navigator;
    private static final class Target {
        final VirtualFile file;
        final String url;
        volatile Document approved;
        volatile long documentStamp;
        volatile SourceVersion diskVersion;
        Target(VirtualFile file) { this.file=file;this.url=file.getUrl(); }
    }
    IntellijAiSource(Project project,Disposable owner,ProjectSourceNavigator navigator) {this.project=project;this.owner=owner;this.navigator=navigator;}
    public void select(SourceTarget target,BooleanSupplier active,Consumer<Source> result) {
        // Resolve locally without opening an editor or reading source contents before consent.
        navigator.select(target,true,active,status->{},file->{
            if(!active.getAsBoolean())return;
            boolean eligible;
            try {
                eligible=ReadAction.compute(()->file!=null && !project.isDisposed() && file.isValid()
                    && file.isInLocalFileSystem() && ProjectFileIndex.getInstance(project).isInContent(file)
                    && "java".equals(file.getExtension()) && file.isWritable()
                    && target.matchesPath(file.getPath()) && file.getLength()<=ReviewedProposal.MAX_CHARS);
            } catch(RuntimeException unavailable){eligible=false;}
            result.accept(eligible?new Source(file.getName(),new Target(file)):null);
        });
    }
    public void confirm(Source source,AiConfiguration.Settings settings,BooleanSupplier active,Consumer<Decision> result) {
        ApplicationManager.getApplication().invokeLater(()->{
            if(!active.getAsBoolean()) return;
            DialogWrapper dialog=new DialogWrapper(project,true) {
                {setTitle("HeapLens: Send Entire Source File?");setOKButtonText("Send Source");init();}
                protected JComponent createCenterPanel() {
                    JTextArea text=new JTextArea("Send the entire current contents of "+source.name()+" to:\n"+settings.endpoint()+
                        "\nProvider: "+AiProviders.get(settings.provider()).label()+"\nModel: "+settings.model()+
                        "\n\nSource is NOT redacted and may contain secrets, comments or proprietary code. Heap metadata is included; the local path is not. " +
                        "A local endpoint may forward data elsewhere. Provider charges and data policies apply.\n\n"+
                        "Review Source opens the file locally and cancels this request. Cancel or closing this dialog sends nothing. " +
                        "If you approve, the AI proposal opens in a temporary merge preview. Arrows select individual changes. " +
                        "Only Apply reviewed changes edits the project file, with normal Undo/Redo. Cancel leaves it unchanged. " +
                        "A changed, moved or replaced source file cannot be overwritten by this proposal.",15,65);
                    text.setEditable(false);text.setLineWrap(true);text.setWrapStyleWord(true);text.setCaretPosition(0);return new JScrollPane(text);
                }
                @Override protected Action[] createActions() {
                    Action review=new DialogWrapperAction("Review Source") {protected void doAction(ActionEvent event){close(2);}};
                    return new Action[]{getOKAction(),review,getCancelAction()};
                }
            };
            Disposable closer=()->{if(!dialog.isDisposed()) dialog.close(DialogWrapper.CANCEL_EXIT_CODE);};
            Disposer.register(owner,closer);
            try {dialog.show();if(active.getAsBoolean()) result.accept(dialog.getExitCode()==0?Decision.SEND:dialog.getExitCode()==2?Decision.REVIEW:Decision.CANCEL);}
            finally {Disposer.dispose(closer);}
        });
    }
    public String readApproved(Source source) {
        return ReadAction.nonBlocking(()->{
            Target target=(Target)source.handle();
            VirtualFile file=target.file;
            if(project.isDisposed() || !file.isValid() || !file.isInLocalFileSystem()
                || !ProjectFileIndex.getInstance(project).isInContent(file) || !"java".equals(file.getExtension())
                || !file.isWritable() || !target.url.equals(file.getUrl())
                || file.getLength()>1024*1024) throw new IllegalStateException("Source unavailable or too large");
            var document=FileDocumentManager.getInstance().getDocument(file);
            if(document==null || !document.isWritable() || document.getTextLength()>1024*1024) throw new IllegalStateException("Source unavailable or too large");
            target.approved=document;
            target.documentStamp=document.getModificationStamp();
            target.diskVersion=SourceVersion.capture(file.toNioPath());
            return document.getText();
        }).expireWith(owner).executeSynchronously();
    }
    public void review(Source source) {
        ApplicationManager.getApplication().invokeLater(()->{if(!project.isDisposed()) FileEditorManager.getInstance(project).openFile(((Target)source.handle()).file,true);});
    }
    public void diff(Source source,String original,String proposed,BooleanSupplier active) {
        ApplicationManager.getApplication().invokeLater(()->{
            if(!active.getAsBoolean() || project.isDisposed()) return;
            Target target=(Target)source.handle();
            String proposalText=StringUtil.convertLineSeparators(proposed);
            ReviewedProposal proposal=new ReviewedProposal(original,proposalText);
            Document preview=EditorFactory.getInstance().createDocument(original);
            AtomicBoolean finished=new AtomicBoolean();
            try {
                var request=DiffRequestFactory.getInstance().createMergeRequest(project,target.file.getFileType(),preview,
                    List.of(original,original,proposalText),"HeapLens AI Proposal: "+source.name()+" (temporary review; Cancel changes nothing)",
                    List.of("Approved source snapshot","Reviewed result (not yet applied)","AI proposal (may be incorrect)"),result->{
                        if(!finished.compareAndSet(false,true) || result==MergeResult.CANCEL)return;
                        String reviewed=result==MergeResult.LEFT?original:result==MergeResult.RIGHT?proposalText:preview.getText();
                        applyReviewed(target,proposal,reviewed,active);
                    });
                request.putUserData(com.intellij.diff.util.DiffUserDataKeysEx.MERGE_ACTION_CAPTIONS,result->switch(result){
                    case CANCEL->"Cancel";case LEFT->"Keep original";case RIGHT->"Apply entire AI proposal";case RESOLVED->"Apply reviewed changes";
                });
                DiffManager.getInstance().showMerge(project,request);
            } catch(InvalidDiffRequestException failure) {
                Messages.showErrorDialog(project,"Could not open the proposal review. No file was changed.","HeapLens AI Proposal");
            }
        });
    }
    private void applyReviewed(Target target,ReviewedProposal proposal,String reviewed,BooleanSupplier active) {
        try {
            WriteCommandAction.runWriteCommandAction(project,"Apply HeapLens reviewed AI changes",null,()->{
                VirtualFile file=target.file;
                Document current=FileDocumentManager.getInstance().getDocument(file);
                boolean same=current!=null && current==target.approved && file.isValid() && target.url.equals(file.getUrl())
                    && current.getModificationStamp()==target.documentStamp && target.diskVersion!=null
                    && target.diskVersion.unchanged(file.toNioPath());
                boolean writable=!project.isDisposed() && file.isInLocalFileSystem() && file.isWritable()
                    && ProjectFileIndex.getInstance(project).isInContent(file) && "java".equals(file.getExtension())
                    && current!=null && current.isWritable() && file.getLength()<=ReviewedProposal.MAX_CHARS;
                proposal.check(current==null?null:current.getText(),reviewed,active.getAsBoolean(),same,writable);
                if(!current.getText().equals(reviewed))current.setText(reviewed);
            });
            if(!project.isDisposed()) FileEditorManager.getInstance(project).openFile(target.file,true);
        } catch(RuntimeException failure) {
            if(!project.isDisposed())Messages.showWarningDialog(project,
                failure instanceof IllegalStateException?failure.getMessage():"Could not apply the reviewed proposal. No automatic file overwrite was attempted.",
                "HeapLens: Proposal Not Applied");
        }
    }
}
